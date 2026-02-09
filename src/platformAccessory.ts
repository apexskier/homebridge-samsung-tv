import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from "homebridge";
import fs from "node:fs/promises";
import path from "node:path";
// unfortunately we can't use the built-in node:ws support because we need
// to accept a self-signed certificate
import WebSocket from "ws";
import wol from "wol";

import { HomebridgePlatform as HomebridgePlatform } from "./platform";

type SamsungWSMessage =
  | {
      event: "ms.channel.connect";
      data: {
        clients: Array<{
          attributes: {
            name: string; // base64 encoded, what we sent
          };
          connectTime: number; // time since epoch, ms, I think
          deviceName: string; // base64 encoded, what we sent
          id: string;
          isHost: boolean;
        }>;
        id: string;
        token?: string; // only present if new connection
      };
    }
  | { event: "ms.channel.timeOut" }
  | { event: "ms.error"; data: { message: string } };

type Key =
  | "KEY_POWER"
  | "KEY_REWIND"
  | "KEY_FF"
  | "KEY_UP"
  | "KEY_DOWN"
  | "KEY_LEFT"
  | "KEY_RIGHT"
  | "KEY_ENTER"
  | "KEY_RETURN"
  | "KEY_HOME"
  | "KEY_PLAY_BACK"
  | "KEY_INFO";

// https://github.com/roberodin/ha-samsungtv-custom/blob/d28fa56707fdafde898eefc9afb2f9fdafdfe175/custom_components/samsungtv_custom/samsungctl_080b/remote_websocket.py#L459
type OutgoingWSMessage =
  | {
      method: "ms.remote.control";
      params:
        | {
            Cmd: "Press" | "Click" | "Release";
            DataOfCmd: Key;
            Option: false;
            TypeOfRemote: "SendRemoteKey";
          }
        | {
            Cmd: string; // base64 encoded
            TypeOfRemote: "SendInputString";
            DataOfCmd: "base64";
          }
        | {
            Cmd: "Move";
            x: number;
            y: number;
            Time: number; // ???
            TypeOfRemote: "ProcessMouseDevice";
          };
    }
  | {
      method: "ms.channel.emit";
      params:
        | {
            data: "";
            event: "ed.edenApp.get";
            to: "host";
          }
        | {
            data: {
              appId: "org.tizen.browser";
              action_type: "NATIVE_LAUNCH";
              metaTag: string; // url
            };
            event: "ed.apps.launch";
            to: "host";
          };
    };

export interface TVInfo {
  device: {
    EdgeBlendingSupport: "true" | "false";
    EdgeBlendingSupportGroup: string; // stringified int
    FrameTVSupport: "true" | "false";
    GamePadSupport: "true" | "false";
    ImeSyncedSupport: "true" | "false";
    Language: string;
    OS: "Tizen";
    PowerState: "on" | "standby";
    TokenAuthSupport: "true" | "false";
    VoiceSupport: "true" | "false";
    WallScreenRatio: string; // stringified int?
    WallService: "true" | "false";
    countryCode: string;
    description: string;
    developerIP: string; // "0.0.0.0";
    developerMode: string; // "0";
    duid: `uuid:${string}`;
    firmwareVersion: string; // "Unknown";
    id: `uuid:${string}`;
    ip: string;
    model: string;
    modelName: string;
    name: string;
    networkType: "wired" | "wireless";
    resolution: `${number}x${number}`;
    smartHubAgreement: "true" | "false";
    type: string;
    udn: `uuid:${string}`;
    wifiMac: string;
  };
  id: `uuid:${string}`;
  isSupport: '{"DMP_DRM_PLAYREADY":"false","DMP_DRM_WIDEVINE":"false","DMP_available":"true","EDEN_available":"true","FrameTVSupport":"false","ImeSyncedSupport":"true","TokenAuthSupport":"true","remote_available":"true","remote_fourDirections":"true","remote_touchPad":"true","remote_voiceControl":"true"}\n';
  name: string;
  remote: string;
  type: string;
  uri: string; // "http://192.168.4.152:8001/api/v2/";
  version: string; //"2.0.25";
}

interface TVSupport {
  DMP_DRM_PLAYREADY: "false" | "true";
  DMP_DRM_WIDEVINE: "false" | "true";
  DMP_available: "true" | "false";
  EDEN_available: "true" | "false";
  FrameTVSupport: "false" | "true";
  ImeSyncedSupport: "true" | "false";
  TokenAuthSupport: "true" | "false";
  remote_available: "true" | "false";
  remote_fourDirections: "true" | "false";
  remote_touchPad: "true" | "false";
  remote_voiceControl: "true" | "false";
}

function isConnectMessage(
  msg: SamsungWSMessage,
): msg is SamsungWSMessage & { event: "ms.channel.connect" } {
  return msg.event === "ms.channel.connect";
}

export interface AccessoryContext {
  device: TVInfo;
}

export class MyPlatformAccessory {
  private ws?: WebSocket;

  private tvService: Service;
  private currentPowerChangePromise: Promise<void> = Promise.resolve();
  private nextPowerChange: () => Promise<void> = () => Promise.resolve();

  constructor(
    private readonly platform: HomebridgePlatform,
    private readonly accessory: PlatformAccessory<AccessoryContext>,
  ) {
    const isSupport = JSON.parse(
      this.accessory.context.device.isSupport,
    ) as TVSupport;

    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        this.accessory.context.device.type,
      )
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../package.json").version,
      )
      .setCharacteristic(
        this.platform.Characteristic.Name,
        this.accessory.context.device.device.name,
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        this.accessory.context.device.device.modelName,
      );
    this.accessory.category = this.platform.api.hap.Categories.TELEVISION;
    this.platform.api.updatePlatformAccessories([this.accessory]);

    const tvService =
      this.accessory.getService(this.platform.Service.Television) ||
      this.accessory.addService(this.platform.Service.Television);
    this.tvService = tvService;
    tvService
      .setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        this.accessory.context.device.name,
      )
      .setCharacteristic(
        this.platform.Characteristic.SleepDiscoveryMode,
        this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE,
      )
      .setCharacteristic(this.platform.Characteristic.ActiveIdentifier, 1)
      .setCharacteristic(
        this.platform.Characteristic.Active,
        this.accessory.context.device.device.PowerState === "on"
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      );

    const logSet =
      (label: string, fn: (value: CharacteristicValue) => Promise<void>) =>
      (value: CharacteristicValue) => {
        this.platform.log.debug(label, value);
        return fn(value);
      };

    if (isSupport.remote_available === "true") {
      (tvService.testCharacteristic(this.platform.Characteristic.RemoteKey)
        ? tvService.getCharacteristic(this.platform.Characteristic.RemoteKey)
        : tvService.addCharacteristic(this.platform.Characteristic.RemoteKey)
      ).onSet(
        logSet("remote key", async (value: CharacteristicValue) => {
          let key: Key | null = null;
          // https://github.com/vrachieru/samsung-tv-api/blob/master/samsungtv/remote.py
          switch (value) {
            case this.platform.Characteristic.RemoteKey.REWIND:
              key = "KEY_REWIND";
              break;
            case this.platform.Characteristic.RemoteKey.FAST_FORWARD:
              key = "KEY_FF";
              break;
            case this.platform.Characteristic.RemoteKey.NEXT_TRACK:
              break;
            case this.platform.Characteristic.RemoteKey.PREVIOUS_TRACK:
              break;
            case this.platform.Characteristic.RemoteKey.ARROW_UP:
              key = "KEY_UP";
              break;
            case this.platform.Characteristic.RemoteKey.ARROW_DOWN:
              key = "KEY_DOWN";
              break;
            case this.platform.Characteristic.RemoteKey.ARROW_LEFT:
              key = "KEY_LEFT";
              break;
            case this.platform.Characteristic.RemoteKey.ARROW_RIGHT:
              key = "KEY_RIGHT";
              break;
            case this.platform.Characteristic.RemoteKey.SELECT:
              key = "KEY_ENTER";
              break;
            case this.platform.Characteristic.RemoteKey.BACK:
              key = "KEY_RETURN";
              break;
            case this.platform.Characteristic.RemoteKey.EXIT:
              key = "KEY_HOME";
              break;
            case this.platform.Characteristic.RemoteKey.PLAY_PAUSE:
              key = "KEY_PLAY_BACK";
              break;
            case this.platform.Characteristic.RemoteKey.INFORMATION:
              key = "KEY_INFO";
              break;
          }

          if (!key) {
            return;
          }

          await this.send({
            method: "ms.remote.control",
            params: {
              Cmd: "Click",
              DataOfCmd: key,
              Option: false,
              TypeOfRemote: "SendRemoteKey",
            },
          });
        }),
      );
    }

    tvService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(
        logSet("Set Active", async (value: CharacteristicValue) => {
          this.setActive(
            value === this.platform.Characteristic.Active.INACTIVE
              ? "standby"
              : "on",
          );
        }),
      );

    this.connect();
  }

  private async waitForPowerState(
    condition: "on" | "standby" | ((state: "on" | "standby" | null) => boolean),
    signal: AbortSignal,
  ): Promise<void> {
    while (
      typeof condition === "string"
        ? condition !== (await this.powerState())
        : !condition(await this.powerState())
    ) {
      if (signal.aborted) {
        throw new Error(`Timed out waiting for power state: ${condition}`);
      }
      this.platform.log.debug(`waiting for power state: ${condition}...`);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  // This is slow, so needs to run async from the characteristic handler
  // https://github.com/homebridge/homebridge/wiki/Characteristic-Warnings#this-plugin-slows-down-homebridge
  //
  // This will wait for the previous setActive invocation to finish, then execute
  // the "last" setActive invocation. If multiple setActive calls are made in
  // quick succession, only the last one will be executed after the await.
  private async setActive(powerTarget: "on" | "standby") {
    const powerChange = async () => {
      const lastPowerChange = new AbortController();
      setTimeout(
        () => lastPowerChange.abort(new Error("setActive timeout")),
        20_000,
      );
      const signal = lastPowerChange.signal;

      if ((await this.powerState()) === null) {
        this.platform.log.debug("turning tv on");
        await wol.wake(this.accessory.context.device.device.wifiMac);
        await this.waitForPowerState((state) => state !== null, signal);
        await this.connect();
      }

      if (powerTarget === (await this.powerState())) {
        this.platform.log.debug(`TV in target power state: ${powerTarget}`);
        return;
      }

      this.platform.log.debug(`setting TV ${powerTarget}...`);
      await this.send({
        method: "ms.remote.control",
        params: {
          Cmd: "Click",
          DataOfCmd: "KEY_POWER",
          Option: false,
          TypeOfRemote: "SendRemoteKey",
        },
      });
      await this.waitForPowerState(powerTarget, signal);

      this.tvService
        .getCharacteristic(this.platform.Characteristic.Active)
        .updateValue(
          (await this.powerState()) === "on"
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE,
        );

      // give a bit of a buffer, the tv doesn't like rapid power state changes
      await new Promise((resolve) => setTimeout(resolve, 1000));

      this.currentPowerChangePromise = this.nextPowerChange();
    };

    this.platform.log.debug(`Queueing power change to ${powerTarget}`);
    await this.currentPowerChangePromise;
    this.platform.log.debug(`Starting power change to ${powerTarget}`);
    this.currentPowerChangePromise = powerChange();
    this.nextPowerChange = powerChange;
  }

  private get deviceName() {
    return `Homebridge - ${this.accessory.context.device.name}`;
  }

  private getStoragePath(): string {
    return path.format({
      dir: this.platform.api.user.storagePath(),
      base: `samsung-tv-${this.accessory.context.device.id}.json`,
    });
  }

  async loadToken(): Promise<string | null> {
    const storagePath = this.getStoragePath();

    try {
      const data = JSON.parse(await fs.readFile(storagePath, "utf8")) as {
        version: 1;
        token: string;
      };

      if (data.version !== 1) {
        this.platform.log.warn("Outdated file version, re-authenticating...");
        return null;
      }

      this.platform.log.debug("Loaded auth token from storage");
      return data.token;
    } catch (err) {
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      this.platform.log.warn("Failed to load auth token:", err);
      await fs.unlink(storagePath);
    }

    return null;
  }

  async saveToken(token: string): Promise<void> {
    const data = { version: 1, token };
    this.platform.log.debug("Saving auth token");
    await fs.writeFile(this.getStoragePath(), JSON.stringify(data), "utf8");
  }

  private connectionPromise?: Promise<WebSocket>;

  async connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    const searchParams = new URLSearchParams();
    searchParams.append(
      "name",
      Buffer.from(this.deviceName).toString("base64"),
    );
    const token = await this.loadToken();
    if (token) {
      searchParams.append("token", token);
    }

    this.ws?.close();
    this.ws = undefined;

    return (this.connectionPromise = new Promise<WebSocket>(
      (resolve, reject) => {
        const url = `wss://${
          this.accessory.context.device.device.ip
        }:8002/api/v2/channels/samsung.remote.control?${searchParams.toString()}`;
        const ws = new WebSocket(url, {
          rejectUnauthorized: false,
        });
        this.ws = ws;
        ws.addEventListener("open", () => {
          this.platform.log.debug(
            `Opening connection to "${this.accessory.context.device.name}"`,
          );
        });
        ws.addEventListener("error", (err) => {
          if (
            err.message === "Invalid WebSocket frame: invalid status code 1005"
          ) {
            this.platform.log.warn(
              `You need to allow access for "${this.deviceName}" on your TV.`,
            );
            resolve(this.connect());
          } else {
            this.platform.log.error(
              `WebSocket error for Samsung TV ${this.accessory.context.device.name}:`,
              err,
            );
            this.connectionPromise = undefined;
            ws.close();
            reject(err);
          }
        });
        ws.addEventListener("message", async (message) => {
          const data = JSON.parse(message.data.toString()) as SamsungWSMessage;
          if (isConnectMessage(data)) {
            this.platform.log.debug(
              `WebSocket connected ${this.accessory.context.device.name}`,
            );
            if (data.data.token) {
              this.platform.log.debug(
                `Received new token from ${this.accessory.context.device.name}: ${data.data.token}`,
              );
              // Save token
              await this.saveToken(data.data.token);
            }
            resolve(ws);
          } else {
            this.platform.log.warn(
              `Received unknown message from ${this.accessory.context.device.name}:`,
              data,
            );
          }
        });

        return this.ws;
      },
    ));
  }

  private async getActive() {
    const powerState = await this.powerState();
    switch (powerState) {
      case "on":
        return this.platform.Characteristic.Active.ACTIVE;
      case "standby":
        return this.platform.Characteristic.Active.INACTIVE;
      case null:
        return this.platform.Characteristic.Active.INACTIVE;
      default:
        this.platform.log.warn(`Unknown PowerState: ${powerState}`);
        return this.platform.Characteristic.Active.INACTIVE;
    }
  }

  private async powerState() {
    try {
      return (await this.refresh()).device.PowerState;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return null;
      }
      throw error;
    }
  }

  private async refresh() {
    const abortController = new AbortController();
    setTimeout(() => {
      abortController.abort();
    }, 1000);
    const response = await fetch(
      `http://${this.accessory.context.device.device.ip}:8001/api/v2/`,
      { signal: abortController.signal },
    );
    return (await response.json()) as TVInfo;
  }

  private async send(event: OutgoingWSMessage) {
    (await this.connect()).send(JSON.stringify(event));
  }
}

import { CharacteristicValue, PlatformAccessory } from "homebridge";
import WebSocket from "ws";
import wol from "wol";

import { HomebridgePlatform as HomebridgePlatform } from "./platform";

export const COMMAND_COALESCE_WINDOW_MS = 500;

type SamsungWSMessage = {
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
};

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

function isConnectMessage(
  msg: SamsungWSMessage,
): msg is SamsungWSMessage & { event: "ms.channel.connect" } {
  return msg.event === "ms.channel.connect";
}

export interface AccessoryContext {
  device: TVInfo;
  token?: string;
}

export class MyPlatformAccessory {
  private ws: WebSocket;

  // you can't turn the tv on immediately after turning off, wait a bit
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly platform: HomebridgePlatform,
    private readonly accessory: PlatformAccessory<AccessoryContext>,
  ) {
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

        this.send({
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
    tvService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActive.bind(this))
      .onSet(
        logSet("Set Active", async (value: CharacteristicValue) => {
          const targetState =
            value === this.platform.Characteristic.Active.INACTIVE
              ? "standby"
              : "on";
          await this.shutdownPromise;
          let currentState = await this.powerState();
          if (currentState === targetState) {
            this.platform.log.debug(
              `TV already in target power state: ${targetState}`,
            );
            return;
          }
          if (targetState === "on") {
            this.platform.log.debug("turning tv on");
            while (currentState === null) {
              this.platform.log.debug("waiting for TV to power on...");
              await wol.wake(this.accessory.context.device.device.wifiMac);
              currentState = await this.powerState();
            }
            this.send({
              method: "ms.remote.control",
              params: {
                Cmd: "Click",
                DataOfCmd: "KEY_POWER",
                Option: false,
                TypeOfRemote: "SendRemoteKey",
              },
            });
            while ((await this.powerState()) !== "on") {
              this.platform.log.debug("waiting for TV to wake...");
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
          } else {
            this.platform.log.debug("turning tv off");
            this.send({
              method: "ms.remote.control",
              params: {
                Cmd: "Press", // must be Press, not Click
                DataOfCmd: "KEY_POWER",
                Option: false,
                TypeOfRemote: "SendRemoteKey",
              },
            });
            while ((await this.powerState()) === "on") {
              this.platform.log.debug("waiting for TV to shut down...");
              await new Promise((resolve) => setTimeout(resolve, 400));
            }
            this.shutdownPromise = new Promise((resolve) => {
              setTimeout(resolve, 2000);
            });
          }
          tvService
            .getCharacteristic(this.platform.Characteristic.Active)
            .updateValue(value);
        }),
      );

    const searchParams = new URLSearchParams();
    searchParams.append(
      "name",
      Buffer.from(
        `Homebridge - ${this.accessory.context.device.name}`,
      ).toString("base64"),
    );
    if (this.accessory.context.token) {
      searchParams.append("token", this.accessory.context.token);
    }

    const url = `wss://${
      this.accessory.context.device.device.ip
    }:8002/api/v2/channels/samsung.remote.control?${searchParams.toString()}`;
    // unfortunately we can't use the built-in node:ws support because we need
    // to accept a self-signed certificate
    this.ws = new WebSocket(url, {
      rejectUnauthorized: false,
    });
    this.ws.addEventListener("open", () => {
      this.platform.log.debug(
        `Connected to Samsung TV ${this.accessory.context.device.name}`,
      );
    });
    this.ws.addEventListener("error", (err) => {
      this.platform.log.error(
        `WebSocket error for Samsung TV ${this.accessory.context.device.name}:`,
        err,
      );
    });
    this.ws.addEventListener("message", (message) => {
      const data = JSON.parse(message.data.toString()) as SamsungWSMessage;
      if (isConnectMessage(data)) {
        this.platform.log.info(
          `WebSocket connected to Samsung TV ${this.accessory.context.device.name}`,
        );
        if (data.data.token) {
          this.platform.log.info(
            `Received new token from Samsung TV ${this.accessory.context.device.name}: ${data.data.token}`,
          );
          // Save token
          this.accessory.context.token = data.data.token;
          this.platform.api.updatePlatformAccessories([this.accessory]);
        }
      }
    });
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

  private send(event: OutgoingWSMessage) {
    this.ws.send(JSON.stringify(event));
  }
}

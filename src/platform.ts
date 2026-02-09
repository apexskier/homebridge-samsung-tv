import {
  API,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  IndependentPlatformPlugin,
} from "homebridge";

import { PLUGIN_NAME } from "./settings";
import {
  AccessoryContext,
  MyPlatformAccessory,
  TVInfo,
} from "./platformAccessory";
import { Config } from "./config";

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class HomebridgePlatform implements IndependentPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory<AccessoryContext>[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig & Partial<Config>,
    public readonly api: API,
  ) {
    this.log.debug("Finished initializing platform:", this.config);

    if (!config.ip) {
      this.log.error("missing username");
      return;
    }

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on("didFinishLaunching", async () => {
      log.debug("Executed didFinishLaunching callback");
      // run the method to discover / register your devices as accessories
      // await this.authorize();
      await this.discover();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory<AccessoryContext>) {
    this.log.info("Loading accessory from cache:", accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  accessToken: string | null = null;
  refreshToken: string | null = null;

  async discover() {
    const response = await this.fetch(`http://${this.config.ip}:8001/api/v2/`);
    const tvInfo = (await response.json()) as TVInfo;
    if (tvInfo.device.TokenAuthSupport !== "true") {
      this.log.error("TV does not support token authentication");
    }
    const deviceId = tvInfo.id;
    const existingAccessory = this.accessories.find(
      (accessory) => accessory.UUID === this.api.hap.uuid.generate(deviceId),
    );
    if (existingAccessory) {
      this.log.info(
        "Restoring existing accessory from cache:",
        existingAccessory.displayName,
      );
      new MyPlatformAccessory(this, existingAccessory);
    } else {
      this.log.info("Adding new accessory:", tvInfo.name);
      const accessory = new this.api.platformAccessory<AccessoryContext>(
        tvInfo.name,
        this.api.hap.uuid.generate(deviceId),
      );
      accessory.context.device = tvInfo;
      new MyPlatformAccessory(this, accessory);
      this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
    }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(this.accessToken
            ? { Authorization: "Bearer " + this.accessToken }
            : {}),
        },
      });
    } catch (error) {
      this.log.error("failed to fetch", error);
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    if (!response.ok) {
      this.log.warn("non-ok response", input.toString(), await response.text());
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    if (response.status !== 200) {
      this.log.warn("non-200 response", await response.text());
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }

    return response;
  }
}

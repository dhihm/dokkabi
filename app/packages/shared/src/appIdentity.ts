/** Downstream product identity. Upstream package and wire names remain compatible. */
export const APP_IDENTITY = {
  name: "Dokkabi",
  appId: "com.dhihm.dokkabi",
  developmentAppId: "com.dhihm.dokkabi.dev",
  profileDirectory: "dokkabi-desktop",
  developmentProfileDirectory: "dokkabi-desktop-dev",
  stateDirectory: ".dokkabi-desktop",
  scheme: "dokkabi-desktop",
  developmentScheme: "dokkabi-desktop-dev",
} as const;

/** Production updates require a separately reviewed downstream feed contract. */
export const DESKTOP_UPDATES_ENABLED: boolean = false;

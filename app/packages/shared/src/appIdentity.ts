/** Downstream product identity. Upstream package and wire names remain compatible. */
export const APP_IDENTITY = {
  name: "Dokkabi",
  appId: "com.dhihm.dokkabi",
  developmentAppId: "com.dhihm.dokkabi.dev",
  profileDirectory: "dokkabi-app",
  developmentProfileDirectory: "dokkabi-app-dev",
  stateDirectory: ".dokkabi-app",
  scheme: "dokkabi-app",
  developmentScheme: "dokkabi-app-dev",
} as const;

/** Production updates require a separately reviewed downstream feed contract. */
export const DESKTOP_UPDATES_ENABLED: boolean = false;

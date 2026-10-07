/** Packaging hook receives the Electron platform and owned staged directory. */
export default function macNativePrivacy(context: {
  electronPlatformName: string;
  packager: { info: { appDir: string } };
}): Promise<void>;

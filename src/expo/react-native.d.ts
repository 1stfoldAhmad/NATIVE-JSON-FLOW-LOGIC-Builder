// Minimal structural declaration so the adapter can optionally integrate
// react-native's AppState without a hard dependency (react-native remains a
// peer of the host Expo app, not of this package).
declare module "react-native" {
  export const AppState: {
    readonly currentState: string;
    addEventListener(
      type: "change",
      listener: (state: string) => void,
    ): { remove(): void };
  };
}

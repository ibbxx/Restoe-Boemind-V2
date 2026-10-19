export const PROFILES = ["INU", "SOLAR_BAWAH"] as const;
export type Profile = (typeof PROFILES)[number];

export function parseProfile(value: unknown): Profile {
  if (value !== "INU" && value !== "SOLAR_BAWAH") {
    throw new TypeError("Profile must be INU or SOLAR_BAWAH.");
  }
  return value;
}

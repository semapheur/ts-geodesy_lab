export interface SelectOption<T> {
  label: string;
  value: T;
}

export interface SelectGroup<T> {
  label: string;
  options: readonly SelectOption<T>[];
}

export const SHOW_OPTIONS = [
  { value: "geoid", label: "Geoid" },
  { value: "ellipsoid", label: "Ellipsoids" },
  { value: "both", label: "Geoid over ellipsoid mesh" },
] as const;

export type Show = (typeof SHOW_OPTIONS)[number]["value"];

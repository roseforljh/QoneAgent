import { twMerge, type ClassNameValue } from "tailwind-merge";

export type ClassValue = ClassNameValue;

export function cn(...inputs: ClassValue[]) {
  return twMerge(...inputs);
}

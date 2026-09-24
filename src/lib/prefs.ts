import { useEffect, useState } from "react";
import { getWithFallback, setWithFallback } from "./storage";

// Renderer-level behavior prefs (localStorage-backed, live across components).
const EVENT = "babylon:pref-changed";

export type BoolPrefKey = "streamResponses" | "statsCard";
export type StringPrefKey = "chatFont" | "promptFont" | "codeFont" | "statsCardPos" | "canvasWidth";

export function readBoolPref(key: BoolPrefKey, fallback: boolean): boolean {
  const v = getWithFallback(key);
  return v == null ? fallback : v === "1";
}

export function writeBoolPref(key: BoolPrefKey, value: boolean): void {
  setWithFallback(key, value ? "1" : "0");
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { key } }));
}

export function useBoolPref(key: BoolPrefKey, fallback: boolean): boolean {
  const [value, setValue] = useState(() => readBoolPref(key, fallback));
  useEffect(() => {
    const onChange = () => setValue(readBoolPref(key, fallback));
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [key, fallback]);
  return value;
}

export function readStringPref(key: StringPrefKey, fallback: string): string {
  return getWithFallback(key) ?? fallback;
}

export function writeStringPref(key: StringPrefKey, value: string): void {
  setWithFallback(key, value);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { key } }));
}

export function useStringPref(key: StringPrefKey, fallback: string): string {
  const [value, setValue] = useState(() => readStringPref(key, fallback));
  useEffect(() => {
    const onChange = () => setValue(readStringPref(key, fallback));
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [key, fallback]);
  return value;
}

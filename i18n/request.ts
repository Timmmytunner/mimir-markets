import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

// Provide a recursive deep merge
function deepMerge(target: any, source: any): any {
  if (target === null || target === undefined) return source;
  if (source === null || source === undefined) return target;
  
  if (typeof target !== "object" || typeof source !== "object") {
    return source !== undefined ? source : target;
  }
  
  if (Array.isArray(target) && Array.isArray(source)) {
    return source; 
  }
  
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && !Array.isArray(source[key]) && key in target) {
      output[key] = deepMerge(target[key], source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}

export { deepMerge }; // exported for testing

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = routing.locales.includes(requested as any)
    ? requested!
    : routing.defaultLocale;

  let raw = {};
  try {
    raw = (await import(`../messages/${locale}.json`)).default;
  } catch (err) {
    // Missing locale file - next-intl handles this if messages is empty
  }

  let messages = raw;

  if (locale !== routing.defaultLocale) {
    try {
      const defaultRaw = (await import(`../messages/${routing.defaultLocale}.json`)).default;
      messages = deepMerge(defaultRaw, raw);
    } catch (err) {
      // Ignored
    }
  }

  return {
    locale,
    messages,
    getMessageFallback({ namespace, key, error }) {
      const path = [namespace, key].filter((part) => part != null).join(".");

      if (error.code === "MISSING_MESSAGE") {
        // Return raw key to keep contract-first behavior and avoid crashes
        return path;
      }
      return path;
    },
    onError(error) {
      if (error.code === "MISSING_MESSAGE") {
        return; // Mute missing messages to prevent noisy logs or tracking
      }
      console.error(error);
    },
  };
});

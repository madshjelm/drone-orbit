const runtimeProfile = detectRuntimeProfile();

export function getRuntimeProfile() {
  return runtimeProfile;
}

function detectRuntimeProfile() {
  const ua = navigator.userAgent || "";
  const android = /Android/i.test(ua);
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const coarsePointer = safeMatchMedia("(pointer: coarse)");
  const lowCores = (navigator.hardwareConcurrency || 8) <= 4;
  const lowMemory = typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4;
  const embedded = detectEmbedded();
  const prefersReducedMotion = safeMatchMedia("(prefers-reduced-motion: reduce)");

  return {
    android,
    mobile,
    coarsePointer,
    lowCores,
    lowMemory,
    embedded,
    prefersReducedMotion,
    constrained: android || embedded || (coarsePointer && (lowCores || lowMemory))
  };
}

function safeMatchMedia(query) {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  } catch (error) {
    return false;
  }
}

function detectEmbedded() {
  try {
    return window.self !== window.top;
  } catch (error) {
    return true;
  }
}

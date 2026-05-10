/**
 * PDF.js 5.x uses Math.sumPrecise (ES2025) in the worker; Electron 30 / older Chromium may lack it.
 * Install on main thread and inject PDF_WORKER_MATH_SUM_PRECISE_POLYFILL into the worker blob.
 */
function sumPreciseImpl(iterable: Iterable<number>): number {
  if (iterable == null || typeof (iterable as unknown as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    throw new TypeError('Math.sumPrecise expects an iterable of numbers');
  }
  const stack: number[] = [];
  for (const v of iterable) {
    stack.push(Number(v));
  }
  if (stack.length === 0) return 0;
  let level = stack;
  while (level.length > 1) {
    const next: number[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(level[i]! + level[i + 1]!);
      else next.push(level[i]!);
    }
    level = next;
  }
  return level[0]!;
}

export const PDF_WORKER_MATH_SUM_PRECISE_POLYFILL = String.raw`(() => {
  var M = Math;
  if (typeof M.sumPrecise === "function") return;
  M.sumPrecise = function sumPrecise(iterable) {
    if (iterable == null || typeof iterable[Symbol.iterator] !== "function") {
      throw new TypeError("Math.sumPrecise expects an iterable of numbers");
    }
    var stack = [];
    var it = iterable[Symbol.iterator]();
    var step;
    while (!(step = it.next()).done) {
      stack.push(Number(step.value));
    }
    if (stack.length === 0) return 0;
    while (stack.length > 1) {
      var next = [];
      for (var i = 0; i < stack.length; i += 2) {
        if (i + 1 < stack.length) next.push(stack[i] + stack[i + 1]);
        else next.push(stack[i]);
      }
      stack = next;
    }
    return stack[0];
  };
})();`;

export function installMathSumPrecisePolyfill(): void {
  const M = Math as typeof Math & { sumPrecise?: (iterable: Iterable<number>) => number };
  if (typeof M.sumPrecise === 'function') return;
  M.sumPrecise = sumPreciseImpl;
}

void installMathSumPrecisePolyfill();

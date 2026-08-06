// Compares two dotted-numeric version strings, e.g. "1.2.10" vs "1.3.0".
// Returns -1 if a < b, 0 if equal, 1 if a > b. Missing/non-numeric segments
// are treated as 0 so uneven lengths ("1.2" vs "1.2.1") compare sanely.
function compareVersions(a, b) {
  const partsA = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const partsB = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

module.exports = compareVersions;

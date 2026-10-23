export function formatTierTest(title, results) {
  const tiers = results
    .map(r => {
      const symbol = r.tier === 1 ? "!" : r.tier === 2 ? "@" : "#";
      const tierClass = `tier${r.tier}`;
      return `
<dt class="${tierClass}">
  <p>${symbol}</p>
</dt>
<dd>
  <p>${r.text}</p>
</dd>`;
    })
    .join("");

  return `
<h3>${title}</h3>
<dl class="power-roll-display">
${tiers}
</dl>`;
}

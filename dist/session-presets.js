'use strict';
// Shared by the owner UI and backend. These are hard caps, not fee estimates.
(function (root) {
  const modes = Object.freeze({
    standard: Object.freeze({ label: 'Standard', multiplier: 100, gasPerCall: '0.00001', gasBudget: '0.0001' }),
    fast: Object.freeze({ label: 'Fast', multiplier: 125, gasPerCall: '0.00001', gasBudget: '0.0001' })
  });
  function resolve(input, asset, ethers) {
    const gasMode = input.gasMode || 'standard';
    const mode = modes[gasMode];
    if (!mode) throw Error('Choose Standard or Fast fees');
    if (!asset) throw Error('Choose a supported payment token');
    const budget = ethers.parseUnits(String(input.budget), asset.decimals);
    if (budget <= 0n) throw Error('Enter a positive session budget');
    const defaultPerCall = budget / 5n || 1n;
    const perCall = input.perCall || ethers.formatUnits(defaultPerCall, asset.decimals);
    const perCallUnits = ethers.parseUnits(String(perCall), asset.decimals);
    if (perCallUnits <= 0n || perCallUnits > budget) throw Error('Per-call limit must be positive and no greater than the session budget');
    if (input.minutes !== undefined && (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 1440)) throw Error('Session duration must be 1-1440 minutes');
    return { ...input, gasMode, perCall,
      gasPerCall: input.gasMode ? mode.gasPerCall : (input.gasPerCall || mode.gasPerCall),
      gasBudget: input.gasMode ? mode.gasBudget : (input.gasBudget || mode.gasBudget) };
  }
  const api = { modes, resolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OlanasSessionPresets = api;
})(typeof globalThis === 'undefined' ? this : globalThis);

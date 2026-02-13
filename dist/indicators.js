/**
 * Technical indicators for the trading bot
 */
export function calcRSI(closes, period = 14) {
    const rsi = [];
    if (closes.length < period + 1)
        return rsi;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0)
            avgGain += diff;
        else
            avgLoss += Math.abs(diff);
    }
    avgGain /= period;
    avgLoss /= period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
        rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return rsi;
}
export function sma(arr, period) {
    const result = [];
    for (let i = period - 1; i < arr.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++)
            sum += arr[j];
        result.push(sum / period);
    }
    return result;
}
export function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
    const rsiValues = calcRSI(closes, rsiPeriod);
    if (rsiValues.length < stochPeriod)
        return { k: [], d: [], lastK: NaN, lastD: NaN, rsi: rsiValues };
    const rawK = [];
    for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
        const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
        const min = Math.min(...window);
        const max = Math.max(...window);
        rawK.push(max === min ? 50 : ((rsiValues[i] - min) / (max - min)) * 100);
    }
    const k = sma(rawK, kSmooth);
    const d = sma(k, dSmooth);
    return {
        k, d,
        lastK: k[k.length - 1] ?? NaN,
        lastD: d[d.length - 1] ?? NaN,
        lastRSI: rsiValues[rsiValues.length - 1] ?? NaN,
        rsi: rsiValues,
    };
}

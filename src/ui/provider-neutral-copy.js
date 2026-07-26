export function removeProviderBranding(message) {
    return String(message || '').replace(/\bMinerU\b/gi, 'PDF conversion service');
}

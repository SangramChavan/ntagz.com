export const rupees = (paise: number): string => '₹' + Math.round(paise / 100).toLocaleString('en-IN');
// Exact rupees for money that can carry paise (line totals); whole numbers show without decimals.
export const rupeesExact = (paise: number): string => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 });
export const fileSize = (n: number): string => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
export const MAX_FILE = 5 * 1024 * 1024;
export const label = (s: string): string => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function loadPlotConfig(): { width: number } {
  return { width: 100 };
}

export function buildLayoutOptions(): { margin: number } {
  return { margin: 10 };
}

export function escapeHtml(input: string): string {
  return input.replace(/</g, '&lt;');
}

export interface PlotConfig {
  width: number;
}

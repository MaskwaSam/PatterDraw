export interface CalculatorScreenCapture { blob: Blob; width: number; height: number }
export function mountCalculator(host: HTMLElement): {
  screen: HTMLElement;
  captureScreen(): Promise<CalculatorScreenCapture>;
  focus(): void;
  destroy(): void;
};

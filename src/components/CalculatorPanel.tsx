import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { attachCalculatorScreenDrag, type CalculatorScreenDragSession } from "./calculator-screen-drag";
import { mountCalculator } from "../vendor/ti36x/runtime.js";

interface CalculatorPanelProps {
  visible: boolean;
  onClose: () => void;
  onReturnFocus: () => void;
  onBeginScreenDrag: () => CalculatorScreenDragSession | null;
}

/** The panel remains mounted after first use, so hiding never resets an entry. */
export default function CalculatorPanel({ visible, onClose, onReturnFocus, onBeginScreenDrag }: CalculatorPanelProps) {
  const returnFocusRef = useRef(onReturnFocus);
  returnFocusRef.current = onReturnFocus;
  const beginDragRef = useRef(onBeginScreenDrag);
  beginDragRef.current = onBeginScreenDrag;
  const screenDragRef = useRef<ReturnType<typeof attachCalculatorScreenDrag> | null>(null);
  const [screenStatus, setScreenStatus] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const calculatorRef = useRef<ReturnType<typeof mountCalculator> | null>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const resizeRef = useRef<{ x: number; y: number; width: number } | null>(null);
  const fitWidth = (width: number) => Math.max(160, Math.min(width, 520, window.innerWidth - 50, Math.max(160, (window.innerHeight - 100) / 2.2)));
  const [calculatorWidth, setCalculatorWidth] = useState(() => fitWidth(300));
  const [position, setPosition] = useState({ left: Math.max(8, window.innerWidth - 350), top: 80 });
  const move = (left: number, top: number) => {
    const panel = panelRef.current;
    setPosition({
      left: Math.max(8, Math.min(left, window.innerWidth - (panel?.offsetWidth || 332) - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - Math.min(panel?.offsetHeight || 80, window.innerHeight - 16) - 8)),
    });
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const calculator = mountCalculator(hostRef.current);
    calculatorRef.current = calculator;
    const drag = attachCalculatorScreenDrag(calculator.screen, calculator.captureScreen,
      () => beginDragRef.current(), setScreenStatus);
    screenDragRef.current = drag;
    return () => { drag.destroy(); screenDragRef.current = null; calculatorRef.current = null; calculator.destroy(); };
  }, []);

  useLayoutEffect(() => {
    if (!visible) {
      screenDragRef.current?.cancel();
      dragRef.current = null; resizeRef.current = null;
      if (panelRef.current?.contains(document.activeElement)) returnFocusRef.current();
      return;
    }
    move(position.left, position.top);
    // Run after the mount effect, including StrictMode's mount/cleanup cycle.
    const frame = requestAnimationFrame(() => {
      move(position.left, position.top);
      calculatorRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
    // Position changes must not steal focus from the board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    const resize = () => {
      setCalculatorWidth((width) => fitWidth(width));
      setPosition((current) => {
        const panel = panelRef.current;
        return {
        left: Math.max(8, Math.min(current.left, window.innerWidth - (panel?.offsetWidth || 332) - 8)),
        top: Math.max(8, Math.min(current.top, window.innerHeight - Math.min(panel?.offsetHeight || 80, window.innerHeight - 16) - 8)),
      };
      });
    };
    const observer = new ResizeObserver(resize);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, []);

  return (
    <section ref={panelRef} className="calculator-panel" role="region" aria-label="TI-36X Pro calculator"
      data-testid="calculator-panel" data-calculator-input="true" hidden={!visible}
      style={{ left: position.left, top: position.top, width: calculatorWidth + 32, "--calculator-width": `${calculatorWidth}px` } as CSSProperties}
      onKeyDown={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()} onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()} onPaste={(event) => event.stopPropagation()}>
      <div className="calculator-panel-header">
        <button type="button" className="calculator-panel-move" aria-label="Move calculator"
          title="Drag to move. When focused, use arrow keys to move."
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { x: event.clientX, y: event.clientY, ...position };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag) move(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
          }}
          onPointerUp={() => { dragRef.current = null; }}
          onPointerCancel={() => { dragRef.current = null; }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 40 : 10;
            const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
            if (delta) { event.preventDefault(); move(position.left + delta[0], position.top + delta[1]); }
          }}>⠿ TI-36X Pro</button>
        <button type="button" aria-label="Hide calculator" onClick={onClose}>×</button>
      </div>
      <div className="calculator-panel-body"><div ref={hostRef} data-calculator-input="true" /></div>
      <button type="button" className="calculator-panel-resize" aria-label="Resize calculator" aria-describedby="calculator-resize-description"
        title="Drag to resize. Arrow keys resize; Shift changes size faster."
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault(); event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeRef.current = { x: event.clientX, y: event.clientY, width: calculatorWidth };
        }}
        onPointerMove={(event) => {
          const resize = resizeRef.current;
          if (!resize) return;
          // Project diagonal movement onto the calculator's fixed body aspect.
          const delta = ((event.clientX - resize.x) + (event.clientY - resize.y) / 2.2) / 2;
          setCalculatorWidth(fitWidth(resize.width + delta));
        }}
        onPointerUp={() => { resizeRef.current = null; }}
        onPointerCancel={() => { resizeRef.current = null; }}
        onKeyDown={(event) => {
          const direction = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
          if (!direction) return;
          event.preventDefault();
          setCalculatorWidth((width) => fitWidth(width + direction * (event.shiftKey ? 30 : 10)));
        }}>◢</button>
      <span className="sr-only" id="calculator-resize-description">Width {Math.round(calculatorWidth)} pixels. Drag diagonally or use arrow keys to resize. Shift changes size faster.</span>
      <span className="sr-only" role="status" aria-live="polite">{screenStatus}</span>
    </section>
  );
}

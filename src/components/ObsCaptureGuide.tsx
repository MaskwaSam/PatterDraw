import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export type ObsCaptureGuideLayout = "viewport" | "visible" | "widescreen";

interface ObsCaptureGuideProps {
  layout: ObsCaptureGuideLayout;
}

interface GuideSize {
  height: number;
  width: number;
}

const WIDESCREEN_ASPECT_RATIO = 16 / 9;

export function ObsCaptureGuide({ layout }: ObsCaptureGuideProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<GuideSize | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const { height, width } = stage.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const next = layout !== "widescreen"
        ? { height, width }
        : width / height > WIDESCREEN_ASPECT_RATIO
          ? { height, width: height * WIDESCREEN_ASPECT_RATIO }
          : { height: width / WIDESCREEN_ASPECT_RATIO, width };
      setSize((current) => (
        current
        && Math.abs(current.height - next.height) < 0.5
        && Math.abs(current.width - next.width) < 0.5
          ? current
          : next
      ));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [layout]);

  const style = size
    ? ({
        "--obs-guide-height": `${size.height}px`,
        "--obs-guide-width": `${size.width}px`,
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={stageRef}
      className="obs-capture-guide"
      data-layout={layout}
      data-testid="obs-capture-guide"
      role="region"
      aria-label={layout === "viewport"
        ? "OBS full canvas capture area"
        : layout === "visible"
          ? "OBS visible canvas capture area"
          : "OBS 16:9 capture area"}
    >
      <div className="obs-capture-guide-frame" style={style}>
        {layout === "widescreen" ? <span>OBS · 16:9 capture area</span> : null}
        {layout === "visible" ? <span>OBS · visible canvas</span> : null}
      </div>
    </div>
  );
}

import type { LassoPoint } from "./stable-element-adapter";

export interface LassoViewportTransform {
  offsetLeft: number;
  offsetTop: number;
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
}

export function lassoViewportToScenePoint(
  clientX: number,
  clientY: number,
  transform: LassoViewportTransform,
): LassoPoint {
  return [
    (clientX - transform.offsetLeft) / transform.zoom.value - transform.scrollX,
    (clientY - transform.offsetTop) / transform.zoom.value - transform.scrollY,
  ];
}

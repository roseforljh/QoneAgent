import { motion, useReducedMotion } from "motion/react";

type Point = readonly [number, number];

function moveToward(from: Point, to: Point, amount: number): Point {
  return [from[0] + (to[0] - from[0]) * amount, from[1] + (to[1] - from[1]) * amount];
}

function roundedShape(corners: readonly Point[], radius: number): string {
  const vertices = corners.map((point, index) => {
    const previous = corners[(index + corners.length - 1) % corners.length];
    const next = corners[(index + 1) % corners.length];
    const previousDistance = Math.hypot(previous[0] - point[0], previous[1] - point[1]);
    const nextDistance = Math.hypot(next[0] - point[0], next[1] - point[1]);
    const before = moveToward(point, previous, previousDistance ? Math.min(0.5, radius / previousDistance) : 0);
    const after = moveToward(point, next, nextDistance ? Math.min(0.5, radius / nextDistance) : 0);
    return { point, before, after };
  });
  const previous = vertices.at(-1)!;
  const format = (point: Point) => point.map((coordinate) => coordinate.toFixed(4)).join(" ");

  return `M${format(previous.after)} ${vertices.map(({ point, before, after }) =>
    `C${format(before)} ${format(before)} ${format(before)} C${format(moveToward(before, point, 0.552285))} ${format(moveToward(after, point, 0.552285))} ${format(after)}`,
  ).join(" ")} Z`;
}

function roundedStroke(start: Point, end: Point, width: number): string {
  const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const normal: Point = [(end[1] - start[1]) * width / (2 * distance), (start[0] - end[0]) * width / (2 * distance)];
  const tangent: Point = [-normal[1], normal[0]];
  const corners: Point[] = [
    [start[0] - normal[0] - tangent[0], start[1] - normal[1] - tangent[1]],
    [start[0] + normal[0] - tangent[0], start[1] + normal[1] - tangent[1]],
    [end[0] + normal[0] + tangent[0], end[1] + normal[1] + tangent[1]],
    [end[0] - normal[0] + tangent[0], end[1] - normal[1] + tangent[1]],
  ];
  return roundedShape(corners, width / 2);
}

const CENTER = roundedShape([[10, 10], [10, 10], [10, 10], [10, 10]], 0);
const SEND_PATHS = [
  roundedStroke([10, 4.5], [10, 16.667], 1.33),
  roundedStroke([4.167, 9.167], [10, 3.333], 1.33),
  roundedStroke([10, 3.333], [15.833, 9.167], 1.33),
  CENTER,
];
const STOP_PATHS = [
  roundedShape([[4.5, 4.5], [15.5, 4.5], [15.5, 15.5], [4.5, 15.5]], 1.25),
  CENTER,
  CENTER,
  CENTER,
];

export function ComposerActionGlyph({ stopped }: { stopped: boolean }) {
  const reducedMotion = useReducedMotion();
  const paths = stopped ? STOP_PATHS : SEND_PATHS;

  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true">
      {paths.map((path, index) => (
        <motion.path
          key={index}
          initial={false}
          animate={{ d: path }}
          transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: [0.25, 0.46, 0.45, 0.94] }}
        />
      ))}
    </svg>
  );
}

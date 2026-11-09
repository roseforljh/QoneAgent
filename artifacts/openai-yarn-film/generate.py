"""Procedural 40-second OpenAI yarn film: 1280x720, 60 fps, generated audio."""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import wave
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parent
FFMPEG = Path(__file__).resolve().parents[2] / "apps" / "desktop" / "src-tauri" / "binaries" / "ffmpeg.exe"
WIDTH, HEIGHT, FPS, DURATION = 1280, 720, 60, 40
SAMPLE_RATE = 48_000

PALETTE = [
    (244, 94, 116),   # coral
    (245, 184, 74),   # amber
    (117, 207, 133),  # mint
    (67, 190, 205),   # cyan
    (93, 122, 232),   # blue
    (188, 112, 211),  # violet
]
LIGHTS = [(255, 86, 96), (255, 206, 61), (96, 235, 135), (77, 210, 255), (112, 134, 255), (230, 115, 245)]


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def smoothstep(value: float) -> float:
    value = clamp(value)
    return value * value * (3.0 - 2.0 * value)


def ease_in_out(value: float) -> float:
    value = clamp(value)
    return 0.5 - 0.5 * math.cos(math.pi * value)


def fade_window(t: float, start: float, end: float, softness: float = 0.8) -> float:
    return smoothstep((t - start) / softness) * (1.0 - smoothstep((t - end) / softness))


def hex_color(color: tuple[int, int, int]) -> np.ndarray:
    return np.array(color, dtype=np.uint8)


def line_points(points: np.ndarray, amount: float) -> np.ndarray:
    if len(points) < 2:
        return points
    distances = np.sqrt(np.sum(np.diff(points, axis=0) ** 2, axis=1))
    total = float(distances.sum())
    target = total * clamp(amount)
    result = [points[0]]
    travelled = 0.0
    for index, distance in enumerate(distances):
        if travelled + distance >= target:
            ratio = 0.0 if distance == 0 else (target - travelled) / distance
            result.append(points[index] + (points[index + 1] - points[index]) * ratio)
            break
        result.append(points[index + 1])
        travelled += float(distance)
    return np.asarray(result, dtype=np.float32)


def logo_segments(radius: float = 132.0) -> list[np.ndarray]:
    """Six rounded links arranged as a hand-drawn OpenAI-inspired knot."""
    segments: list[np.ndarray] = []
    for link in range(6):
        angle = link * math.tau / 6.0 - math.pi / 2.0
        cx = math.cos(angle) * radius * 0.44
        cy = math.sin(angle) * radius * 0.44
        major = radius * 0.50
        minor = radius * 0.19
        points = []
        for step in range(49):
            theta = step / 48.0 * math.tau
            # The long axis is tangent to the ring, creating the six interlocking petals.
            tangent = angle + math.pi / 2.0
            x = cx + math.cos(theta) * major * math.cos(tangent) - math.sin(theta) * minor * math.sin(tangent)
            y = cy + math.cos(theta) * major * math.sin(tangent) + math.sin(theta) * minor * math.cos(tangent)
            points.append((x, y))
        segments.append(np.asarray(points, dtype=np.float32))
    return segments


def load_project_logo() -> list[np.ndarray]:
    route_file = ROOT / "logo-route.json"
    if not route_file.exists():
        return logo_segments()
    route = np.asarray(json.loads(route_file.read_text(encoding="utf-8"))["route"], dtype=np.float32)
    scale = 72.0
    route[:, 0] *= scale
    route[:, 1] *= scale
    cuts = np.linspace(0, len(route), 7, dtype=int)
    return [route[cuts[i]:cuts[i + 1]] for i in range(6)]


LOGO = load_project_logo()
RELAY_PATH = np.asarray(
    [(150 + i * 13.0, 520 + 30.0 * math.sin(i / 15.0)) for i in range(78)], dtype=np.float32
)


def build_floor_base() -> np.ndarray:
    canvas = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    height = np.arange(HEIGHT, dtype=np.float32)[:, None]
    horizon = 0.32 * HEIGHT
    floor_mix = np.clip((height - horizon) / (HEIGHT - horizon), 0.0, 1.0)
    top = np.array([10, 12, 16], dtype=np.float32)
    bottom = np.array([3, 4, 6], dtype=np.float32)
    image = top * (1.0 - floor_mix[..., None]) + bottom * floor_mix[..., None]
    canvas[:] = np.repeat(image, WIDTH, axis=1).astype(np.uint8)
    cv2.line(canvas, (0, int(horizon)), (WIDTH, int(horizon)), (33, 37, 43), 2, cv2.LINE_AA)
    for depth in range(9):
        y = int(horizon + (depth / 9.0) ** 1.65 * (HEIGHT - horizon))
        cv2.line(canvas, (0, y), (WIDTH, y), (10, 13, 17), 1, cv2.LINE_AA)
    for x in range(-800, WIDTH + 800, 96):
        cv2.line(canvas, (WIDTH // 2 + (x - WIDTH // 2) // 8, int(horizon)), (x, HEIGHT), (9, 12, 15), 1, cv2.LINE_AA)
    return canvas


FLOOR_BASE = build_floor_base()
yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH]
distance = np.sqrt(((xx - WIDTH / 2) / (WIDTH / 2)) ** 2 + ((yy - HEIGHT / 2) / (HEIGHT / 2)) ** 2)
VIGNETTE = np.clip((distance - 0.48) * 0.22, 0.0, 0.18).astype(np.float32)


def world_to_screen(point: np.ndarray | tuple[float, float], camera=(0.0, 0.0, 1.0)) -> tuple[int, int]:
    x, y = float(point[0]), float(point[1])
    offset_x, offset_y, scale = camera
    return int(WIDTH / 2 + (x + offset_x) * scale), int(HEIGHT / 2 + (y + offset_y) * scale)


def logo_on_floor(camera: tuple[float, float, float]) -> list[np.ndarray]:
    # Floor logo center is slightly below the horizon so its sheen reads on the glossy surface.
    result = []
    for segment in LOGO:
        mapped = [world_to_screen((p[0], -p[1] + 100.0), camera) for p in segment]
        result.append(np.asarray(mapped, dtype=np.int32))
    return result


def draw_glow(canvas: np.ndarray, points: np.ndarray, color: tuple[int, int, int], width: int, glow: float = 1.0) -> None:
    if len(points) < 2:
        return
    glow_layer = np.zeros_like(canvas)
    cv2.polylines(glow_layer, [points], False, color, max(width * 3, 4), cv2.LINE_AA)
    blurred = cv2.GaussianBlur(glow_layer, (0, 0), 12 + 12 * glow)
    canvas[:] = cv2.addWeighted(canvas, 1.0, blurred, 0.5 * glow, 0)
    cv2.polylines(canvas, [points], False, color, width, cv2.LINE_AA)


def draw_yarn(canvas: np.ndarray, points: np.ndarray, amount: float = 1.0, bright: bool = False, color=(238, 239, 236)) -> None:
    visible = line_points(points, amount)
    if len(visible) < 2:
        return
    draw_glow(canvas, visible.astype(np.int32), (112, 118, 122), 13 if bright else 10, 0.7)
    draw_glow(canvas, visible.astype(np.int32), color, 7 if bright else 5, 0.55)
    # Small irregular fibers sell the material as felt yarn instead of a vector stroke.
    for index in range(2, len(visible), 5):
        p = visible[index]
        q = visible[max(index - 2, 0)]
        tangent = p - q
        length = max(float(np.linalg.norm(tangent)), 1.0)
        normal = np.array([-tangent[1], tangent[0]]) / length
        a = tuple(np.int32(p - normal * 3.5))
        b = tuple(np.int32(p + normal * 3.5))
        cv2.line(canvas, a, b, (255, 255, 250), 1, cv2.LINE_AA)


def draw_floor(canvas: np.ndarray, t: float, blackout: float) -> None:
    canvas[:] = FLOOR_BASE
    if blackout > 0:
        canvas[:] = np.clip(canvas.astype(np.float32) * (1.0 - 0.98 * blackout), 0, 255).astype(np.uint8)


def ellipse_points(center: tuple[int, int], rx: int, ry: int, angle: float = 0.0, count: int = 16) -> np.ndarray:
    theta = np.linspace(0, math.tau, count, endpoint=False)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    x = center[0] + rx * np.cos(theta) * cos_a - ry * np.sin(theta) * sin_a
    y = center[1] + rx * np.cos(theta) * sin_a + ry * np.sin(theta) * cos_a
    return np.column_stack((x, y)).astype(np.int32)


def draw_monster(canvas: np.ndarray, x: int, y: int, scale: float, color: tuple[int, int, int], facing: int, push: float, wobble: float, photo: bool = False) -> None:
    cv2.ellipse(canvas, (x, y + int(36 * scale)), (int(40 * scale), int(8 * scale)), 0, 0, 360, (2, 3, 5), -1)

    body = np.array([(x - int(32 * scale), y + int(25 * scale)),
                     (x - int(27 * scale), y - int(22 * scale)),
                     (x - int(9 * scale), y - int(38 * scale)),
                     (x + int(3 * scale), y - int(26 * scale)),
                     (x + int(22 * scale), y - int(34 * scale)),
                     (x + int(34 * scale), y + int(25 * scale))], dtype=np.int32)
    cv2.fillPoly(canvas, [body], color)
    cv2.polylines(canvas, [body], True, tuple(max(0, c - 32) for c in color), max(1, int(2 * scale)), cv2.LINE_AA)
    # Felt fibers and stitch dots are deterministic so reruns remain identical.
    for strand in range(13):
        px = x - int(28 * scale) + (strand * 5 % max(8, int(56 * scale)))
        py = y - int(24 * scale) + ((strand * 17) % max(12, int(45 * scale)))
        cv2.line(canvas, (px, py), (px + int((strand % 3 - 1) * 3 * scale), py - int(5 * scale)), tuple(min(255, c + 30) for c in color), max(1, int(scale)), cv2.LINE_AA)

    # Horns / ears.
    ear_color = tuple(max(0, c - 20) for c in color)
    cv2.fillPoly(canvas, [np.array([(x - int(22 * scale), y - int(24 * scale)), (x - int(30 * scale), y - int(51 * scale)), (x - int(8 * scale), y - int(37 * scale))])], ear_color)
    cv2.fillPoly(canvas, [np.array([(x + int(10 * scale), y - int(35 * scale)), (x + int(29 * scale), y - int(52 * scale)), (x + int(27 * scale), y - int(19 * scale))])], ear_color)
    eye_y = y - int(8 * scale)
    for eye_x in (x - int(12 * scale), x + int(12 * scale)):
        cv2.circle(canvas, (eye_x, eye_y), max(2, int(6 * scale)), (246, 245, 239), -1, cv2.LINE_AA)
        cv2.circle(canvas, (eye_x + facing * max(1, int(2 * scale)), eye_y), max(1, int(2.3 * scale)), (12, 15, 19), -1, cv2.LINE_AA)
    cv2.ellipse(canvas, (x, y + int(7 * scale)), (int(7 * scale), int(5 * scale)), 0, 10, 170, (41, 26, 38), max(1, int(2 * scale)), cv2.LINE_AA)

    hand_x = x + facing * int((31 + push * 15) * scale)
    hand_y = y + int((2 + wobble * 2) * scale)
    cv2.line(canvas, (x + facing * int(18 * scale), y + int(10 * scale)), (hand_x, hand_y), tuple(max(0, c - 10) for c in color), max(2, int(5 * scale)), cv2.LINE_AA)
    cv2.circle(canvas, (hand_x, hand_y), max(3, int(6 * scale)), tuple(min(255, c + 18) for c in color), -1, cv2.LINE_AA)
    if photo:
        cv2.line(canvas, (x - int(11 * scale), y + int(26 * scale)), (x - int(14 * scale), y + int(41 * scale)), tuple(max(0, c - 25) for c in color), max(2, int(3 * scale)), cv2.LINE_AA)
        cv2.line(canvas, (x + int(11 * scale), y + int(26 * scale)), (x + int(14 * scale), y + int(41 * scale)), tuple(max(0, c - 25) for c in color), max(2, int(3 * scale)), cv2.LINE_AA)


def draw_ball(canvas: np.ndarray, x: int, y: int, radius: int, rotation: float, glow: float = 0.4) -> None:
    glow_layer = np.zeros_like(canvas)
    cv2.circle(glow_layer, (x, y), int(radius * 1.7), (140, 145, 155), -1, cv2.LINE_AA)
    canvas[:] = cv2.addWeighted(canvas, 1.0, cv2.GaussianBlur(glow_layer, (0, 0), 12), glow, 0)
    cv2.circle(canvas, (x, y), radius, (234, 235, 230), -1, cv2.LINE_AA)
    cv2.circle(canvas, (x - radius // 3, y - radius // 3), max(1, radius // 5), (255, 255, 252), -1, cv2.LINE_AA)
    for stripe in range(5):
        theta = rotation + stripe * math.tau / 5.0
        x1 = x + int(math.cos(theta) * radius * 0.76)
        y1 = y + int(math.sin(theta) * radius * 0.76)
        x2 = x + int(math.cos(theta + 0.16) * radius * 0.76)
        y2 = y + int(math.sin(theta + 0.16) * radius * 0.76)
        cv2.line(canvas, (x1, y1), (x2, y2), (198, 201, 198), max(1, radius // 12), cv2.LINE_AA)


def draw_text(canvas: np.ndarray, text: str, xy: tuple[int, int], size: float, color: tuple[int, int, int], weight: int = 1, anchor: str = "left") -> None:
    font = cv2.FONT_HERSHEY_SIMPLEX
    thickness = max(1, int(weight))
    (tw, th), _ = cv2.getTextSize(text, font, size, thickness)
    x, y = xy
    if anchor == "center":
        x -= tw // 2
    elif anchor == "right":
        x -= tw
    cv2.putText(canvas, text, (x, y), font, size, color, thickness, cv2.LINE_AA)


def draw_camera_flash(canvas: np.ndarray, amount: float) -> None:
    if amount <= 0:
        return
    flash = np.full_like(canvas, 255)
    canvas[:] = cv2.addWeighted(canvas, 1.0 - amount, flash, amount, 0)
    center = (WIDTH // 2, HEIGHT // 2)
    for radius in (60, 150, 250, 390):
        cv2.ellipse(canvas, center, (radius, radius // 2), 0, 0, 360, (255, 255, 255), max(1, int(5 * amount)), cv2.LINE_AA)


def frame_at(frame_index: int) -> np.ndarray:
    t = frame_index / FPS
    blackout = smoothstep((t - 30.8) / 1.0) * (1.0 - smoothstep((t - 35.9) / 1.2))
    canvas = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    draw_floor(canvas, t, blackout)

    # Camera drift keeps the procedural scene from feeling like a static diagram.
    camera = (math.sin(t * 0.18) * 5.0, math.cos(t * 0.21) * 2.0, 1.0)
    relay_progress = clamp((t - 3.0) / 14.0)
    reveal_progress = clamp((t - 16.0) / 10.0)
    stand_progress = smoothstep((t - 24.0) / 6.0)
    light_progress = clamp((t - 31.5) / 4.0)

    floor_logo = logo_on_floor(camera)
    if t < 27.0:
        draw_text(canvas, "SIX HANDS  /  ONE THREAD", (64, 76), 0.65, (87, 93, 103), 1)
        draw_text(canvas, "OPENAI", (64, 111), 1.0, (224, 225, 219), 2)

    # The first yarn strand is pushed across the reflective black floor.
    relay_visible = line_points(RELAY_PATH, relay_progress)
    relay_screen = np.asarray([world_to_screen((p[0] - 640, p[1] - 360), camera) for p in relay_visible])
    if len(relay_screen) > 1:
        draw_yarn(canvas, relay_screen, bright=False)
    ball_world = RELAY_PATH[min(int(relay_progress * (len(RELAY_PATH) - 1)), len(RELAY_PATH) - 1)]
    ball_x, ball_y = world_to_screen((ball_world[0] - 640, ball_world[1] - 360), camera)
    rotation = relay_progress * 26.0

    # Six cute felt helpers move in a relay rhythm around the ball.
    for monster_index in range(6):
        phase = (t * 0.44 + monster_index / 6.0) % 1.0
        handoff_start = 3.0 + monster_index * 2.35
        active = smoothstep((t - handoff_start) / 0.42) * (1.0 - smoothstep((t - handoff_start - 1.05) / 0.42))
        offset_x = (monster_index - 2.5) * 176.0
        offset_y = 104.0 + 18.0 * math.sin(phase * math.tau + monster_index)
        if t < 18.0:
            # Every helper has a station on the floor and briefly walks behind the ball to push it.
            push_target_x = ball_world[0] - 72.0
            mx_world = offset_x * (1.0 - active) + push_target_x * active
            my_world = offset_y * (1.0 - active) + 103.0 * active
            mx, my = world_to_screen((mx_world, my_world), camera)
            draw_monster(canvas, mx, my, 0.84, PALETTE[monster_index], 1, active, math.sin(t * 7 + monster_index), False)

    if t < 17.0:
        draw_ball(canvas, ball_x, ball_y, 29, rotation, 0.45)
        draw_text(canvas, "PASS THE SPARK", (WIDTH - 64, HEIGHT - 55), 0.58, (104, 111, 119), 1, "right")

    # The trail curls into the logo, one interlocking link at a time.
    if reveal_progress > 0:
        per_segment = reveal_progress * len(floor_logo)
        for index, segment in enumerate(floor_logo):
            amount = clamp(per_segment - index)
            draw_yarn(canvas, segment.astype(np.int32), amount, bright=stand_progress > 0.1)
        if reveal_progress < 1.0:
            segment_index = min(5, int(per_segment))
            segment = floor_logo[segment_index]
            tip = line_points(segment.astype(np.float32), per_segment - segment_index)[-1]
            draw_ball(canvas, int(tip[0]), int(tip[1]), 21, t * 7, 0.25)

    # The logo swells from a thread into a plush sculpture.
    if stand_progress > 0:
        rise = ease_in_out(stand_progress)
        for index, segment in enumerate(floor_logo):
            lifted = segment.astype(np.float32).copy()
            lifted[:, 1] = lifted[:, 1] * (1.0 - 0.46 * rise) - 130.0 * rise
            shade = tuple(max(0, int(c - 28)) for c in (238, 239, 236))
            draw_glow(canvas, lifted.astype(np.int32), shade, 16, 0.35)
            draw_glow(canvas, lifted.astype(np.int32), (239, 240, 237), 10, 0.65)
        if t < 31.0:
            draw_text(canvas, "A LITTLE HELP FROM EACH OTHER", (WIDTH // 2, 92), 0.62, (160, 165, 169), 1, "center")

    # Lights race through the six links and merge at the center.
    if light_progress > 0:
        center = np.array([WIDTH // 2, HEIGHT // 2 - 20], dtype=np.float32)
        running = light_progress * 1.15
        for index, segment in enumerate(floor_logo):
            lifted = segment.astype(np.float32).copy()
            lifted[:, 1] = lifted[:, 1] * 0.54 - 130.0
            lit_amount = clamp(running * 1.5 - index * 0.12)
            trail = line_points(lifted, lit_amount)
            if len(trail) > 1:
                draw_glow(canvas, trail.astype(np.int32), LIGHTS[index], 14, 1.0)
                tip = trail[-1]
                cv2.circle(canvas, tuple(np.int32(tip)), 22, LIGHTS[index], -1, cv2.LINE_AA)
                cv2.circle(canvas, tuple(np.int32(tip)), 8, (255, 255, 255), -1, cv2.LINE_AA)
        convergence = smoothstep((light_progress - 0.68) / 0.32)
        cv2.circle(canvas, tuple(np.int32(center)), int(48 * convergence), (255, 255, 255), -1, cv2.LINE_AA)
        canvas[:] = cv2.addWeighted(canvas, 1.0, cv2.GaussianBlur(canvas, (0, 0), 24), 0.1 * convergence, 0)

    # Flash-photo finale: the monsters line up with the finished mark.
    final = smoothstep((t - 35.4) / 1.0)
    if final > 0:
        canvas[:] = np.clip(canvas.astype(np.float32) * (1.0 - 0.82 * final), 0, 255).astype(np.uint8)
        photo_y = 568
        spacing = 105
        for index in range(6):
            px = WIDTH // 2 + (index - 2.5) * spacing
            draw_monster(canvas, int(px), photo_y + int(7 * math.sin(index)), 0.86, PALETTE[index], 1, 0.0, 0.0, True)
        photo_logo = []
        for segment in floor_logo:
            lifted = segment.astype(np.float32).copy()
            lifted[:, 1] = lifted[:, 1] * 0.48 - 150
            photo_logo.append(lifted.astype(np.int32))
        for segment in photo_logo:
            draw_glow(canvas, segment, (244, 245, 241), 10, 0.8)
        draw_text(canvas, "OPENAI", (WIDTH // 2, 610), 1.18, (244, 245, 241), 2, "center")
        draw_text(canvas, "MADE TOGETHER", (WIDTH // 2, 653), 0.62, (168, 174, 178), 1, "center")
        flash = max(0.0, math.sin((t - 36.7) * math.pi * 3.0)) ** 14
        draw_camera_flash(canvas, flash)

    # Soft vignette gives the matte-black stage a cinematic edge.
    canvas[:] = np.clip(canvas.astype(np.float32) * (1.0 - VIGNETTE[..., None]), 0, 255).astype(np.uint8)
    return canvas


def add_sine(audio: np.ndarray, frequency: float, start: float, duration: float, amplitude: float, sample_rate: int = SAMPLE_RATE) -> None:
    first = max(0, int(start * sample_rate))
    last = min(len(audio), first + int(duration * sample_rate))
    if last <= first:
        return
    time = np.arange(last - first, dtype=np.float32) / sample_rate
    envelope = np.minimum(1.0, time / 0.025) * np.minimum(1.0, (duration - time) / 0.12)
    audio[first:last] += np.sin(math.tau * frequency * time) * np.maximum(0.0, envelope) * amplitude


def make_audio(path: Path) -> None:
    length = int(DURATION * SAMPLE_RATE)
    time = np.arange(length, dtype=np.float32) / SAMPLE_RATE
    audio = np.zeros(length, dtype=np.float32)
    # Warm pad, arpeggio and a low pulse keep the music hand-made and code-generated.
    chords = [(146.83, 0.14), (174.61, 0.10), (220.00, 0.08), (261.63, 0.06)]
    for frequency, amplitude in chords:
        audio += np.sin(math.tau * frequency * time) * amplitude * (0.75 + 0.25 * np.sin(time * 0.17))
    for beat in np.arange(0.0, DURATION, 0.5):
        add_sine(audio, 86.0, float(beat), 0.24, 0.13)
        add_sine(audio, 174.61, float(beat + 0.25), 0.08, 0.045)
    for note_time in np.arange(2.0, 30.0, 0.5):
        note = [293.66, 349.23, 440.0, 523.25][int(note_time * 2) % 4]
        add_sine(audio, note, float(note_time), 0.18, 0.07)
    for index, note_time in enumerate(np.arange(31.5, 36.0, 0.75)):
        add_sine(audio, 440.0 + index * 41.0, float(note_time), 0.48, 0.13)
    for frequency in (261.63, 329.63, 392.0, 523.25):
        add_sine(audio, frequency, 37.0, 2.5, 0.16)

    rng = np.random.default_rng(20261008)
    noise = rng.normal(0, 1, length).astype(np.float32)
    yarn_envelope = np.zeros(length, dtype=np.float32)
    yarn_envelope += np.clip((time - 5.0) / 2.0, 0, 1) * np.clip((19.0 - time) / 2.0, 0, 1) * 0.035
    yarn_envelope += np.clip((time - 24.0) / 2.0, 0, 1) * np.clip((31.0 - time) / 2.0, 0, 1) * 0.028
    audio += noise * yarn_envelope
    # Six percussive felt taps when the helpers hand off the ball.
    for handoff in np.arange(5.2, 17.0, 2.0):
        add_sine(audio, 118.0, float(handoff), 0.12, 0.28)
        add_sine(audio, 64.0, float(handoff), 0.18, 0.16)
    # Camera shutter + flash crack.
    add_sine(audio, 920.0, 36.8, 0.11, 0.30)
    add_sine(audio, 1560.0, 36.86, 0.065, 0.18)
    audio *= np.minimum(1.0, np.arange(length, dtype=np.float32) / (0.35 * SAMPLE_RATE))
    audio *= np.minimum(1.0, np.arange(length - 1, -1, -1, dtype=np.float32) / (0.5 * SAMPLE_RATE))
    audio = np.tanh(audio * 1.55) * 0.72
    stereo = np.column_stack((audio, audio * 0.985)).astype(np.float32)
    pcm = np.clip(stereo * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(pcm.tobytes())


def run_ffmpeg(arguments: list[str]) -> None:
    command = [str(FFMPEG), "-hide_banner", "-loglevel", "error", *arguments]
    subprocess.run(command, check=True)


def render_video(path: Path) -> None:
    command = [str(FFMPEG), "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "-", "-an", "-c:v", "h264_nvenc", "-preset", "p4", "-cq", "19", "-pix_fmt", "yuv420p", str(path)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None
    try:
        for frame_index in range(DURATION * FPS):
            process.stdin.write(frame_at(frame_index).tobytes())
            if frame_index and frame_index % (FPS * 5) == 0:
                print(f"视频帧 {frame_index}/{DURATION * FPS}", flush=True)
    finally:
        process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("FFmpeg 视频编码失败")


def validate_video(path: Path) -> None:
    capture = cv2.VideoCapture(str(path))
    assert capture.isOpened(), f"无法读取视频: {path}"
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = capture.get(cv2.CAP_PROP_FPS)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    capture.release()
    assert width == WIDTH and height == HEIGHT, (width, height)
    assert abs(fps - FPS) < 0.1, fps
    assert abs(frames - DURATION * FPS) <= 1, frames
    print(f"视频自检通过: {width}x{height}, {fps:.3f} fps, {frames} 帧", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Render the procedural OpenAI yarn film")
    parser.add_argument("--smoke", action="store_true", help="只生成关键帧并检查音频合成")
    args = parser.parse_args()
    if not FFMPEG.exists():
        raise FileNotFoundError(f"项目内 FFmpeg 不存在: {FFMPEG}")
    ROOT.mkdir(parents=True, exist_ok=True)
    if args.smoke:
        for frame_index in (0, 360, 1020, 1500, 1920, 2399):
            frame = frame_at(frame_index)
            assert frame.shape == (HEIGHT, WIDTH, 3) and frame.dtype == np.uint8
            cv2.imwrite(str(ROOT / f"smoke-{frame_index:04d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
        make_audio(ROOT / "smoke.wav")
        print("烟雾测试通过: 6 张关键帧 + 40 秒 WAV", flush=True)
        return

    silent_video = ROOT / "openai-yarn-film-silent.mp4"
    audio = ROOT / "openai-yarn-film.wav"
    final_video = ROOT / "openai-yarn-film.mp4"
    render_video(silent_video)
    make_audio(audio)
    run_ffmpeg(["-y", "-i", str(silent_video), "-i", str(audio), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(final_video)])
    validate_video(final_video)
    silent_video.unlink(missing_ok=True)
    print(f"成片已生成: {final_video}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)

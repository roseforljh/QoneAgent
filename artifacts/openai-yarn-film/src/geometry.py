"""Extract the project OpenAI mark into a continuous, sampled yarn route."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path
import xml.etree.ElementTree as ET

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def svg_contours(path: str) -> list[np.ndarray]:
    tokens = re.findall(r"[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?", path)
    arity = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "A": 7}
    contours, points = [], []
    position = np.zeros(2)
    start = position.copy()
    command = "M"
    i = 0
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
        upper = command.upper()
        if upper == "Z":
            points.append(start.copy())
            contours.append(np.array(points))
            points = []
            position = start.copy()
            continue
        if upper == "A":
            for flag_index in (3, 4):
                token = tokens[i + flag_index]
                if len(token) > 1 and token[0] in "01":
                    tokens[i + flag_index:i + flag_index + 1] = [token[0], token[1:]]
        count = arity[upper]
        values = np.array([float(v) for v in tokens[i:i + count]])
        i += count
        relative = command.islower()
        if upper == "M":
            if points:
                contours.append(np.array(points))
            position = values + position if relative else values
            start = position.copy()
            points = [position.copy()]
            command = "l" if relative else "L"
        elif upper in ("L", "H", "V"):
            destination = position.copy()
            if upper == "L":
                destination = values + position if relative else values
            else:
                axis = 0 if upper == "H" else 1
                destination[axis] = values[0] + (position[axis] if relative else 0)
            steps = max(2, int(np.linalg.norm(destination - position) * 12))
            points.extend(np.linspace(position, destination, steps)[1:])
            position = destination
        elif upper == "C":
            control = values.reshape(3, 2) + (position if relative else 0)
            p0 = position.copy()
            for t in np.linspace(0, 1, 36)[1:]:
                points.append((1-t)**3*p0 + 3*(1-t)**2*t*control[0] + 3*(1-t)*t*t*control[1] + t**3*control[2])
            position = control[2].copy()
        elif upper == "A":
            rx, ry, rotation, large, sweep, ex, ey = values
            destination = np.array([ex, ey]) + (position if relative else 0)
            phi = math.radians(rotation)
            rot = np.array([[math.cos(phi), -math.sin(phi)], [math.sin(phi), math.cos(phi)]])
            prime = rot.T @ ((position - destination) / 2)
            rx, ry = abs(rx), abs(ry)
            if rx == 0 or ry == 0:
                points.append(destination)
                position = destination
                continue
            scale = max(1.0, math.sqrt(prime[0]**2/rx**2 + prime[1]**2/ry**2))
            rx, ry = rx*scale, ry*scale
            numerator = max(0, rx*rx*ry*ry - rx*rx*prime[1]**2 - ry*ry*prime[0]**2)
            denominator = rx*rx*prime[1]**2 + ry*ry*prime[0]**2
            factor = math.sqrt(numerator / max(denominator, 1e-12)) * (-1 if large == sweep else 1)
            center_prime = factor * np.array([rx*prime[1]/ry, -ry*prime[0]/rx])
            center = rot @ center_prime + (position + destination)/2
            a = (prime - center_prime)/np.array([rx, ry])
            b = (-prime - center_prime)/np.array([rx, ry])
            theta = math.atan2(a[1], a[0])
            delta = math.atan2(a[0]*b[1]-a[1]*b[0], float(a@b))
            if not sweep and delta > 0:
                delta -= math.tau
            if sweep and delta < 0:
                delta += math.tau
            for angle in np.linspace(theta, theta+delta, max(8, int(abs(delta)*max(rx, ry)*12)))[1:]:
                points.append(center + rot @ np.array([rx*math.cos(angle), ry*math.sin(angle)]))
            position = destination
    if points:
        contours.append(np.array(points))
    return contours


def thin(mask: np.ndarray) -> np.ndarray:
    image = (mask > 0).astype(np.uint8)
    while True:
        changed = 0
        for phase in range(2):
            p = [np.roll(np.roll(image, dy, 0), dx, 1) for dy, dx in [(1,0),(1,-1),(0,-1),(-1,-1),(-1,0),(-1,1),(0,1),(1,1)]]
            neighbors = sum(p)
            transitions = sum((p[j] == 0) & (p[(j+1)%8] == 1) for j in range(8))
            if phase == 0:
                constraint = (p[0]*p[2]*p[4] == 0) & (p[2]*p[4]*p[6] == 0)
            else:
                constraint = (p[0]*p[2]*p[6] == 0) & (p[0]*p[4]*p[6] == 0)
            remove = (image == 1) & (neighbors >= 2) & (neighbors <= 6) & (transitions == 1) & constraint
            changed += int(remove.sum())
            image[remove] = 0
        if changed == 0:
            return image


def route_from_skeleton(skeleton: np.ndarray) -> tuple[np.ndarray, list[np.ndarray]]:
    pixels = {tuple(p) for p in np.argwhere(skeleton > 0)}
    adjacent = {}
    for y, x in pixels:
        candidates = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                p = (y+dy, x+dx)
                if (dy == 0 and dx == 0) or p not in pixels:
                    continue
                if dy and dx and ((y+dy, x) in pixels or (y, x+dx) in pixels):
                    continue
                candidates.append(p)
        adjacent[(y, x)] = candidates
    # Crossings are small pixel clusters; contract them before following each strand.
    junction = np.zeros_like(skeleton)
    for pixel, neighbors in adjacent.items():
        if len(neighbors) != 2:
            junction[pixel] = 1
    junction = cv2.dilate(junction, np.ones((5,5), np.uint8)) * skeleton
    _, labels = cv2.connectedComponents(junction, connectivity=8)
    nodes = {}
    for pixel in pixels:
        label = int(labels[pixel])
        if label:
            nodes.setdefault(label, []).append(pixel)
    centers = {label: np.mean(group, axis=0) for label, group in nodes.items()}
    edges, seen = [], set()
    for label, group in nodes.items():
        for pixel in group:
            for neighbor in adjacent[pixel]:
                if labels[neighbor] == label or frozenset((pixel, neighbor)) in seen:
                    continue
                route = [centers[label], np.array(neighbor, float)]
                previous, current = pixel, neighbor
                seen.add(frozenset((previous, current)))
                while not labels[current]:
                    candidates = [p for p in adjacent[current] if p != previous]
                    if not candidates:
                        break
                    following = candidates[0]
                    seen.add(frozenset((current, following)))
                    previous, current = current, following
                    route.append(np.array(current, float))
                end = int(labels[current])
                if end and len(route) > 3:
                    route[-1] = centers[end]
                    edges.append((label, end, np.array(route)))
    assert edges, "OpenAI SVG skeleton contains no strands"
    # Euler traversal covers every strand exactly once; the ball really traces the logo.
    graph = {node: [] for node in nodes}
    for index, (a,b,_) in enumerate(edges):
        graph[a].append(index)
        graph[b].append(index)
    start = min(nodes, key=lambda node: centers[node][0])
    visited, stack, result = set(), [(start, None)], []
    while stack:
        node, arrived = stack[-1]
        candidates = [e for e in graph[node] if e not in visited]
        if not candidates:
            stack.pop()
            if arrived is not None:
                result.append(arrived)
            continue
        index = candidates[0]
        visited.add(index)
        a,b,path = edges[index]
        destination = b if node == a else a
        stack.append((destination, (index, node == a)))
    result.reverse()
    strands = [edges[index][2] if forward else edges[index][2][::-1] for index,forward in result]
    assert len(visited) == len(edges), "Disconnected OpenAI strand extraction"
    ordered = np.concatenate(strands)
    # Smooth pixel stair steps and arc-length resample into a stable motion path.
    ordered = cv2.GaussianBlur(ordered.astype(np.float32).reshape(-1,1,2), (1,9), 1.6).reshape(-1,2)
    lengths = np.r_[0, np.cumsum(np.linalg.norm(np.diff(ordered, axis=0), axis=1))]
    distance = np.linspace(0, lengths[-1], 1200)
    route = np.column_stack([np.interp(distance, lengths, ordered[:,axis]) for axis in range(2)])
    route = np.column_stack(((route[:,1]-256)/128, (256-route[:,0])/128))
    converted = [np.column_stack(((p[:,1]-256)/128, (256-p[:,0])/128)) for p in strands]
    return route, converted


def prepare() -> dict:
    project = ROOT.parents[1]
    candidates = list((project / "node_modules/.bun").glob("@lobehub+icons-static-svg@*/node_modules/@lobehub/icons-static-svg/icons/openai.svg"))
    assert candidates, "Cannot find the project's existing OpenAI SVG"
    svg = candidates[0].read_text(encoding="utf-8")
    xml = ET.fromstring(svg)
    path = xml.find("{http://www.w3.org/2000/svg}path").attrib["d"]
    contours = svg_contours(path)
    mask = np.zeros((512,512), np.uint8)
    for contour in contours:
        polygon = np.rint(contour/24*480 + 16).astype(np.int32)
        layer = np.zeros_like(mask)
        cv2.fillPoly(layer, [polygon], 255)
        mask ^= layer
    cv2.imwrite(str(ROOT / "logo-reference.png"), mask)
    skeleton = thin(mask)
    route, strands = route_from_skeleton(skeleton)
    data = {"route": route.tolist(), "strands": [s.tolist() for s in strands], "source": str(candidates[0].relative_to(project))}
    (ROOT / "logo-route.json").write_text(json.dumps(data), encoding="utf-8")
    preview = np.zeros((512,512,3), np.uint8)
    for strand in strands:
        points = np.rint(np.column_stack((strand[:,0]*128+256, 256-strand[:,1]*128))).astype(np.int32)
        cv2.polylines(preview, [points], False, (235,235,230), 22, cv2.LINE_AA)
    cv2.imwrite(str(ROOT / "logo-route-preview.png"), preview)
    print(f"OpenAI geometry: {len(strands)} strands, {len(route)} motion samples", flush=True)
    return data


if __name__ == "__main__":
    prepare()

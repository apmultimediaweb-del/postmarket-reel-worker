import cv2
import json
import os
import sys


def median(values, fallback):
    if not values:
        return fallback
    values = sorted(values)
    return values[len(values) // 2]


def main():
    source = sys.argv[1]
    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        raise RuntimeError("avatar_video_unreadable")

    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    sample_positions = [0.08, 0.18, 0.30, 0.42, 0.54, 0.66, 0.78, 0.90]
    cascade_candidates = [
        os.path.join(getattr(cv2, "data", object()).haarcascades, "haarcascade_frontalface_default.xml")
        if hasattr(getattr(cv2, "data", None), "haarcascades") else "",
        "/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml",
        "/usr/share/opencv/haarcascades/haarcascade_frontalface_default.xml",
    ]
    cascade_path = next((item for item in cascade_candidates if item and os.path.isfile(item)), "")
    cascade = cv2.CascadeClassifier(cascade_path) if cascade_path else None
    face_x = []
    top_edges = []
    bottom_edges = []
    width = height = 0

    for position in sample_positions:
        if frames > 1:
            capture.set(cv2.CAP_PROP_POS_FRAMES, min(frames - 1, int(frames * position)))
        ok, frame = capture.read()
        if not ok:
            continue
        height, width = frame.shape[:2]
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 45, 120)
        row_energy = (edges > 0).mean(axis=1)
        active = [i for i, energy in enumerate(row_energy) if energy > 0.006]
        if active:
            padding = max(2, int(height * 0.008))
            top_edges.append(max(0, active[0] - padding))
            bottom_edges.append(min(height, active[-1] + padding + 1))

        faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=5, minSize=(max(40, width // 18), max(40, height // 18))) if cascade is not None else []
        if len(faces):
            x, y, w, h = max(faces, key=lambda item: item[2] * item[3])
            face_x.append((x + w / 2) / width)

    capture.release()
    if width < 2 or height < 2:
        raise RuntimeError("avatar_video_has_no_frames")

    top = int(median(top_edges, 0))
    bottom = int(median(bottom_edges, height))
    content_height = bottom - top
    if content_height < height * 0.20 or content_height > height * 0.94:
        top, bottom, content_height = 0, height, height

    center_x = min(0.92, max(0.08, float(median(face_x, 0.5))))
    print(json.dumps({"width": width, "height": height, "top": top, "content_height": content_height, "face_x": center_x}))


if __name__ == "__main__":
    main()

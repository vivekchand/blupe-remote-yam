"""Manual browser acceptance with real Codex and explicitly simulated robot IO.

This never connects to a physical robot or the public queue. It uses upstream's
existing synthetic color-image transport check and real MuJoCo trajectory code.
Launching does not call a model; submit the displayed task from the browser.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'src'))

TASK = (
    'ClawMetry acceptance in simulation only. Images are synthetic color markers, '
    'not physical cameras. First request exactly one move_to with only '
    'left_gripper=0.8. After completed simulated feedback, return done and identify '
    'the top, left and right image colors. Do not request any other movement.'
)


def create_app(port):
    from clawmetry_playground import ClawMetryPlayground
    from remote_yam.codex_check import CheckAdapter, check_observation
    from remote_yam.session import MockSessionAPI
    from io import BytesIO
    from PIL import Image

    colors = {'top': (255, 0, 0), 'left': (0, 255, 0), 'right': (0, 0, 255)}
    frames = {}
    for name, color in colors.items():
        output = BytesIO()
        Image.new('RGB', (320, 240), color).save(output, format='JPEG')
        frames[name] = output.getvalue()

    class AcceptancePlayground(ClawMetryPlayground):
        async def http(self, scope, receive, send):
            path = scope['path']
            # This test must not put real robot video beside simulated state.
            # Normal hosted/local playgrounds retain their upstream media path.
            if path.startswith(('/synchronized/', '/live-video/')):
                kind = 'text/javascript' if path.endswith('.js') else 'text/plain'
                return await self.respond(send, 200 if kind == 'text/javascript' else 503,
                    b'/* Explicit synthetic-image acceptance environment. */', kind)
            if path == '/api/past-runs':
                return await self.json(send, 200, {'runs': [], 'next_offset': None, 'stale': False})
            return await super().http(scope, receive, send)

        def camera_frame(self, name, url):
            return frames[name]

    observation = check_observation()
    observation['images'] = {name: {'url': f'http://127.0.0.1:1/synthetic-{name}.jpg'} for name in colors}
    api = MockSessionAPI(observations=[observation])
    app = AcceptancePlayground(
        public_origin=f'http://127.0.0.1:{port}', session_api=None,
        camera_origin='http://127.0.0.1:1', development=True,
        hardware_control=False, local_codex=True, local_claude=False,
        default_provider='codex', api_factory=lambda: api,
        provider_factory=lambda name, key, model, directory: CheckAdapter(
            model=model, recording_root=directory),
        share_conversation=True, camera_names=tuple(colors),
    )
    app.video_stream = None
    app.acceptance_api = api
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=18911)
    args = parser.parse_args()
    import uvicorn
    print('SIMULATION ONLY. No physical robot or public queue is connected.', flush=True)
    print('Submit this task in the browser to use the real local Codex subscription:', flush=True)
    print(TASK, flush=True)
    uvicorn.run(create_app(args.port), host='127.0.0.1', port=args.port,
                workers=1, access_log=False)


if __name__ == '__main__':
    main()

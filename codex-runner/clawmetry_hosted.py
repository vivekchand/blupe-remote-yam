"""Serve the optional integrated playground using visitor-owned model access.

Deployment supplies its HTTPS origin. Local subscription credentials are never
enabled by this public host, and the existing robot gateway remains in charge.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from clawmetry_playground import ClawMetryPlayground
from local_playground import PUBLIC_SESSION_API
from multi_robot import fleet


def create_app(origin, *, session_api=PUBLIC_SESSION_API, allow_hardware_control=True):
    robots = json.loads((Path(__file__).parent / 'config/robots.json').read_text())
    # Provider credentials are supplied per visitor through the native UI.
    return fleet(ClawMetryPlayground, dict(
        public_origin=origin, session_api=session_api, camera_origin=session_api,
        development=False, hardware_control=allow_hardware_control,
        max_sessions=8,
        local_codex=False, local_claude=False, astra_endpoint='',
        groot_key_file='', dream_credentials_file='', share_conversation=True,
    ), robots)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True, help='The HTTPS origin visitors open')
    parser.add_argument('--session-api', default=PUBLIC_SESSION_API)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8795)
    parser.add_argument('--read-only', action='store_true')
    args = parser.parse_args(argv)
    import uvicorn
    app = create_app(args.origin, session_api=args.session_api,
                     allow_hardware_control=not args.read_only)
    uvicorn.run(app, host=args.host, port=args.port, workers=1, access_log=False,
                proxy_headers=False)


if __name__ == '__main__':
    main()

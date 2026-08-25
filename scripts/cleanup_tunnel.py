"""Clean up old SSH tunnel port on the server."""
import paramiko
import sys

HOST = "47.76.188.165"
PORT = 22
USER = "root"
KEY_PATH = "D:/Keys/AliyunKey11.pem"
TUNNEL_PORT = "8000"

try:
    key = paramiko.RSAKey.from_private_key_file(KEY_PATH)
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, port=PORT, username=USER, pkey=key, timeout=5)
    cmd = f"ss -tlnp | grep {TUNNEL_PORT} | grep -o pid=[0-9]* | cut -d= -f2 | sort -u | xargs -r kill 2>/dev/null"
    c.exec_command(cmd)
    c.close()
    print("[SSH] Server port cleaned")
except Exception as e:
    print(f"[SSH] Cleanup failed: {e}", file=sys.stderr)
    sys.exit(1)

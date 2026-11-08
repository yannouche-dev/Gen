"""Tests de instance/agent.py avec de faux serveurs ComfyUI, Vast et Hugging Face.

Lancement : python3 -m unittest discover -s tests/instance -v
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
AGENT = os.path.join(ROOT, "instance", "agent.py")


class Fake:
    """Faux ComfyUI (/queue, /system_stats), faux Vast (PUT /api/v0/instances/<id>/) et faux HF (HEAD resolve)."""

    def __init__(self):
        self.calls = []
        self.busy = False
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, data):
                body = json.dumps(data).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path == "/queue":
                    return self._json(200, {"queue_running": [[0, "x"]] if fake.busy else [], "queue_pending": []})
                if self.path == "/system_stats":
                    return self._json(200, {"system": {}})
                return self._json(404, {})

            def do_HEAD(self):
                fake.calls.append(("HEAD", self.path, self.headers.get("Authorization")))
                if "gated" in self.path:
                    self.send_response(403)
                    self.end_headers()
                    return
                self.send_response(302)
                self.send_header("Location", "https://cdn.example/x")
                self.send_header("X-Linked-Size", "2048")
                self.end_headers()

            def do_PUT(self):
                n = int(self.headers.get("Content-Length", "0"))
                fake.calls.append(("PUT", self.path, self.headers.get("Authorization"), json.loads(self.rfile.read(n))))
                return self._json(200, {"success": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


def get(url, data=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.fake = Fake()
        self.home = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.home, "src"))
        os.makedirs(os.path.join(self.home, "run"))
        os.makedirs(os.path.join(self.home, "ComfyUI", "output", "videogen"))
        os.makedirs(os.path.join(self.home, "ComfyUI", "input", "videogen"))
        weights = {"families": {"fam": {"files": [
            {"repo": "org/repo", "path": "split/diffusion_models/a.safetensors", "dir": "diffusion_models", "name": "a.safetensors"},
            {"repo": "org/repo", "path": "vae/b.safetensors", "dir": "vae", "name": "b.safetensors"}]},
            "gated": {"files": [{"repo": "org/gated", "path": "x.safetensors", "dir": "vae", "name": "x.safetensors"}]}}}
        with open(os.path.join(self.home, "src", "weights.json"), "w") as f:
            json.dump(weights, f)
        # Faux binaire `hf` : écrit un fichier de la taille annoncée dans --local-dir.
        self.hf = os.path.join(self.home, "hf")
        with open(self.hf, "w") as f:
            f.write("#!/bin/sh\n# hf download REPO PATH --local-dir DIR\n"
                    "mkdir -p \"$5/$(dirname $3)\" && head -c 2048 /dev/zero > \"$5/$3\"\n")
        os.chmod(self.hf, 0o755)
        with open(os.path.join(self.home, "run", "boot_ts"), "w") as f:
            f.write(str(time.time()))
        self.env = dict(os.environ, VG_HOME=self.home, COMFY_URL=self.fake.url, VAST_API_BASE=self.fake.url,
                        HF_BASE=self.fake.url, HF_BIN=self.hf, HF_TOKEN="hf_secret_token_123456",
                        COMFY_ACCESS_TOKEN="c" * 43, CONTAINER_API_KEY="container-key-abcdef", CONTAINER_ID="4242",
                        IDLE_MINUTES="0.03", MAX_HOURS="4", WATCHDOG_PERIOD_SECONDS="1", MODELS="fam")
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            p.terminate()
            p.wait(5)
        self.fake.close()
        shutil.rmtree(self.home, ignore_errors=True)

    def run_agent(self, *args, env=None):
        return subprocess.run([sys.executable, AGENT, *args], env=env or self.env, capture_output=True, text=True, timeout=60)

    def serve(self, port, **extra):
        env = dict(self.env, AGENT_PORT=str(port), **extra)
        p = subprocess.Popen([sys.executable, AGENT, "serve"], env=env)
        self.procs.append(p)
        for _ in range(50):
            try:
                return get("http://127.0.0.1:%d/videogen/status" % port)
            except Exception:
                time.sleep(0.1)
        self.fail("agent injoignable")

    def test_fetch_models_downloads_missing_and_reports_progress(self):
        r = self.run_agent("fetch-models")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        st = json.load(open(os.path.join(self.home, "run", "models.json")))
        self.assertEqual(st["state"], "done")
        self.assertEqual(st["total_bytes"], 4096)
        self.assertEqual(st["done_bytes"], 4096)
        self.assertTrue(os.path.exists(os.path.join(self.home, "ComfyUI", "models", "diffusion_models", "a.safetensors")))
        self.assertTrue(os.path.exists(os.path.join(self.home, "ComfyUI", "models", "vae", "b.safetensors")))
        heads = [c for c in self.fake.calls if c[0] == "HEAD"]
        self.assertTrue(all(c[2] == "Bearer hf_secret_token_123456" for c in heads))
        # Deuxième passage : rien à retélécharger.
        os.remove(self.hf)
        self.assertEqual(self.run_agent("fetch-models").returncode, 0)

    def test_gated_repo_gives_clear_error(self):
        r = self.run_agent("fetch-models", env=dict(self.env, MODELS="gated"))
        self.assertEqual(r.returncode, 1)
        st = json.load(open(os.path.join(self.home, "run", "models.json")))
        self.assertEqual(st["state"], "error")
        self.assertIn("accepte la licence", st["error"])
        self.assertNotIn("hf_secret_token_123456", json.dumps(st))

    def test_status_delete_and_path_traversal(self):
        self.run_agent("mark", "comfy_install", "done", "v0.44.2")
        out = os.path.join(self.home, "ComfyUI", "output", "videogen", "vid_00001_.mp4")
        open(out, "w").write("x")
        secret = os.path.join(self.home, "src", "weights.json")
        st = self.serve(18731)
        self.assertEqual(st["steps"]["comfy_install"]["state"], "done")
        self.assertTrue(st["comfy_ready"])
        res = get("http://127.0.0.1:18731/videogen/files/delete", {"files": [
            {"filename": "vid_00001_.mp4", "subfolder": "videogen", "type": "output"},
            {"filename": "../../src/weights.json", "subfolder": "", "type": "output"},
            {"filename": "weights.json", "subfolder": "../../src", "type": "input"},
            {"filename": "x", "subfolder": "", "type": "models"}]})
        self.assertEqual(res["deleted"], ["vid_00001_.mp4"])
        self.assertEqual(len(res["refused"]), 3)
        self.assertFalse(os.path.exists(out))
        self.assertTrue(os.path.exists(secret))
        log = get("http://127.0.0.1:18731/videogen/log?tail=5")
        self.assertNotIn("c" * 43, json.dumps(log))

    def test_watchdog_stops_instance_with_container_key_when_idle(self):
        self.run_agent("mark", "models", "done")
        self.serve(18732)
        deadline = time.time() + 20
        while time.time() < deadline and not [c for c in self.fake.calls if c[0] == "PUT"]:
            time.sleep(0.5)
        puts = [c for c in self.fake.calls if c[0] == "PUT"]
        self.assertTrue(puts, "aucune demande d'arrêt")
        self.assertEqual(puts[0][1], "/api/v0/instances/4242/")
        self.assertEqual(puts[0][2], "Bearer container-key-abcdef")
        self.assertEqual(puts[0][3], {"state": "stopped"})
        st = get("http://127.0.0.1:18732/videogen/status")
        self.assertTrue(st["watchdog"]["triggered"])
        self.assertIn("file vide", st["watchdog"]["reason"])

    def test_list_outputs_by_prefix_and_kept_on_auto_stop(self):
        out_dir = os.path.join(self.home, "ComfyUI", "output", "videogen")
        with open(os.path.join(out_dir, "ltx25-t2v_1731_00001_.mp4"), "w") as f:
            f.write("video")
        with open(os.path.join(out_dir, "autre_00001_.mp4"), "w") as f:
            f.write("x")
        up = os.path.join(self.home, "ComfyUI", "input", "videogen", "vg_img.png")
        with open(up, "w") as f:
            f.write("png")
        self.run_agent("mark", "models", "done")
        self.serve(18735)
        res = get("http://127.0.0.1:18735/videogen/files?prefix=videogen/ltx25-t2v_1731")
        self.assertEqual([f["filename"] for f in res["files"]], ["ltx25-t2v_1731_00001_.mp4"])
        self.assertEqual(res["files"][0]["subfolder"], "videogen")
        with self.assertRaises(urllib.error.HTTPError):
            get("http://127.0.0.1:18735/videogen/files?prefix=../src")
        # Arrêt automatique (inactivité) : la vidéo non récupérée est conservée, l'image envoyée supprimée.
        deadline = time.time() + 20
        while time.time() < deadline and not [c for c in self.fake.calls if c[0] == "PUT"]:
            time.sleep(0.5)
        self.assertTrue([c for c in self.fake.calls if c[0] == "PUT"])
        self.assertTrue(os.path.exists(os.path.join(out_dir, "ltx25-t2v_1731_00001_.mp4")))
        self.assertFalse(os.path.exists(up))

    def test_watchdog_waits_while_downloading_or_busy(self):
        self.run_agent("mark", "models", "running")
        self.serve(18733)
        time.sleep(4)
        self.assertFalse([c for c in self.fake.calls if c[0] == "PUT"], "arrêt pendant le téléchargement")
        self.fake.busy = True
        self.run_agent("mark", "models", "done")
        time.sleep(4)
        self.assertFalse([c for c in self.fake.calls if c[0] == "PUT"], "arrêt alors que la file est occupée")

    def test_max_hours(self):
        with open(os.path.join(self.home, "run", "boot_ts"), "w") as f:
            f.write(str(time.time() - 5 * 3600))
        self.serve(18734, IDLE_MINUTES="0")
        deadline = time.time() + 10
        while time.time() < deadline and not [c for c in self.fake.calls if c[0] == "PUT"]:
            time.sleep(0.3)
        st = get("http://127.0.0.1:18734/videogen/status")
        self.assertIn("durée maximale", st["watchdog"]["reason"] or "")


    def post(self, url, data):
        req = urllib.request.Request(url, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def wait_lora_jobs(self, base):
        deadline = time.time() + 15
        while time.time() < deadline:
            st = get(base + "/videogen/loras")
            if not [j for j in st["jobs"] if j["state"] == "downloading"]:
                return st
            time.sleep(0.2)
        self.fail("téléchargement de LoRA sans fin")

    def test_lora_install_list_delete_and_refusals(self):
        # Faux `hf` qui écrit un vrai en-tête safetensors (8 octets de taille + JSON), sinon des zéros.
        good = os.path.join(self.home, "hf_lora")
        with open(good, "w") as f:
            f.write("#!/bin/sh\n# hf download REPO PATH --local-dir DIR --revision REV\n"
                    "case \"$3\" in *bad*) exec %s \"$@\";; esac\n"
                    "mkdir -p \"$5/$(dirname \"$3\")\" && printf '\\002\\000\\000\\000\\000\\000\\000\\000{}' > \"$5/$3\" "
                    "&& head -c 2038 /dev/zero >> \"$5/$3\"\n" % self.hf)
        os.chmod(good, 0o755)
        base = "http://127.0.0.1:18736"
        self.serve(18736, HF_BIN=good)
        self.assertEqual(get(base + "/videogen/loras")["loras"], [])

        code, job = self.post(base + "/videogen/loras", {"repo": "org/comic-style", "path": "loras/Ink Style.safetensors", "revision": "main", "base": "flux2dev"})
        self.assertEqual(code, 202, job)
        self.assertEqual(job["name"], "videogen/comic-style__Ink_Style.safetensors")
        st = self.wait_lora_jobs(base)
        self.assertEqual([l["name"] for l in st["loras"]], ["videogen/comic-style__Ink_Style.safetensors"])
        self.assertEqual(st["loras"][0]["base"], "flux2dev")
        self.assertEqual(st["loras"][0]["repo"], "org/comic-style")
        path = os.path.join(self.home, "ComfyUI", "models", "loras", "videogen", "comic-style__Ink_Style.safetensors")
        self.assertEqual(os.path.getsize(path), 2048)
        heads = [c for c in self.fake.calls if c[0] == "HEAD" and "comic-style" in c[1]]
        self.assertEqual(heads[0][2], "Bearer hf_secret_token_123456")  # le token HF ne sort que vers HF_BASE
        self.assertIn("/org/comic-style/resolve/main/loras/Ink%20Style.safetensors", heads[0][1])
        # Déjà installée : rien à télécharger.
        code, again = self.post(base + "/videogen/loras", {"repo": "org/comic-style", "path": "loras/Ink Style.safetensors", "base": "flux2dev"})
        self.assertEqual((code, again.get("already")), (200, True))

        # Refus : dépôt, format, base, révision, dépôt protégé, fichier qui n'est pas un safetensors.
        for body, err in [
            ({"repo": "../etc", "path": "a.safetensors", "base": "ltx25"}, "bad_repo"),
            ({"repo": "https://evil.example/x", "path": "a.safetensors", "base": "ltx25"}, "bad_repo"),
            ({"repo": "org/x", "path": "model.ckpt", "base": "ltx25"}, "bad_path"),
            ({"repo": "org/x", "path": "../../a.safetensors", "base": "ltx25"}, "bad_path"),
            ({"repo": "org/x", "path": "a.safetensors", "base": "sdxl"}, "bad_base"),
            ({"repo": "org/x", "path": "a.safetensors", "revision": "main;rm", "base": "ltx25"}, "bad_revision"),
            ({"repo": "org/gated", "path": "a.safetensors", "base": "ltx25"}, "hf"),
        ]:
            code, res = self.post(base + "/videogen/loras", body)
            self.assertEqual((code, res.get("error")), (400, err), body)
        code, job = self.post(base + "/videogen/loras", {"repo": "org/x", "path": "bad.safetensors", "base": "ltx25"})
        self.assertEqual(code, 202)
        st = self.wait_lora_jobs(base)
        self.assertEqual(len(st["loras"]), 1)
        err = [j for j in get(base + "/videogen/loras")["jobs"] if j["file"] == "x__bad.safetensors"]
        self.assertEqual(err[0]["state"], "error")
        self.assertIn("safetensors", err[0]["error"])
        self.assertFalse(os.path.exists(os.path.join(self.home, "ComfyUI", "models", "loras", "videogen", "x__bad.safetensors")))

        # Suppression : chemin hors du dossier refusé, LoRA supprimée.
        for name in ["../../src/weights.json", "videogen/../../../src/weights.json", "manifest.json"]:
            code, _ = self.post(base + "/videogen/loras/delete", {"name": name})
            self.assertEqual(code, 400, name)
        self.assertTrue(os.path.exists(os.path.join(self.home, "src", "weights.json")))
        code, res = self.post(base + "/videogen/loras/delete", {"name": "videogen/comic-style__Ink_Style.safetensors"})
        self.assertEqual(code, 200)
        self.assertFalse(os.path.exists(path))
        self.assertEqual(get(base + "/videogen/loras")["loras"], [])

    def test_lora_size_limit(self):
        base = "http://127.0.0.1:18737"
        self.serve(18737, LORA_MAX_MB="0")
        code, res = self.post(base + "/videogen/loras", {"repo": "org/big", "path": "big.safetensors", "base": "ltx25"})
        self.assertEqual((code, res["error"]), (400, "too_big"))


    def test_step_progress_and_pip_tracking(self):
        req = os.path.join(self.home, "requirements.txt")
        with open(req, "w") as f:
            f.write("torch\nnumpy>=1.25\n# commentaire\nPillow\n")
        pip_out = ("Collecting numpy>=1.25\n"
                   "  Downloading numpy-2.1.0-cp312-cp312-manylinux_2_17_x86_64.whl (16.0 MB)\n"
                   "Requirement already satisfied: torch in /venv/main/lib/python3.12/site-packages\n"
                   "Collecting Pillow\n"
                   "Installing collected packages: numpy, Pillow\n"
                   "Successfully installed Pillow-11.0.0 numpy-2.1.0\n")
        r = subprocess.run([sys.executable, AGENT, "track-pip", "comfy_install", "0.45", "0.92", req],
                           input=pip_out, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, pip_out)  # sortie de pip recopiée telle quelle (logs/pip.log)
        steps = json.load(open(os.path.join(self.home, "run", "steps.json")))
        st = steps["comfy_install"]
        self.assertEqual(st["state"], "running")
        self.assertAlmostEqual(st["pct"], 0.92)
        self.assertEqual(st["msg"], "dépendances installées")
        started = st["started"]
        # Avancement d'une autre étape : secrets masqués ; fin d'étape : durée connue.
        self.run_agent("progress", "comfy_start", "0.3", "chargement… 12 s · token hf_secret_token_123456")
        self.run_agent("mark", "comfy_install", "done", "v0.44.2")
        steps = json.load(open(os.path.join(self.home, "run", "steps.json")))
        self.assertNotIn("hf_secret_token_123456", steps["comfy_start"]["msg"])
        self.assertAlmostEqual(steps["comfy_start"]["pct"], 0.3)
        self.assertEqual(steps["comfy_install"]["started"], started)
        self.assertGreaterEqual(steps["comfy_install"]["ended"], started)
        self.assertEqual(steps["comfy_install"]["pct"], 1.0)
        st = self.serve(18738)
        self.assertEqual(st["steps"]["comfy_start"]["state"], "running")
        self.assertIn("started", st["steps"]["comfy_start"])


if __name__ == "__main__":
    unittest.main()

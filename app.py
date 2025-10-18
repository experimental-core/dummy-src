import os
import base64
import requests
from tqdm import tqdm
from config import CONFIG

GITHUB_TOKEN = CONFIG["GITHUB_TOKEN"]
BRANCH_NAME = CONFIG["GITHUB_BRANCH_NAME"]
REPO_NAME = CONFIG["GITHUB_REPO_NAME"]

def upload_with_real_progress(local_file_path, github_file_path, commit_message):
    owner = REPO_NAME.split("/")[0] if "/" in REPO_NAME else None
    repo_name = REPO_NAME.split("/")[1] if "/" in REPO_NAME else REPO_NAME

    if not owner:
        raise ValueError("GITHUB_REPO_NAME must be in 'owner/repo' format.")

    url = f"https://api.github.com/repos/{owner}/{repo_name}/contents/{github_file_path}"

    file_size = os.path.getsize(local_file_path)
    headers = {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
    }

    # GitHub API requires base64-encoded content, so we encode chunk by chunk
    encoded_chunks = []
    with open(local_file_path, "rb") as f, tqdm(
        total=file_size, unit="B", unit_scale=True, desc="Uploading to GitHub"
    ) as pbar:
        while True:
            chunk = f.read(4096)
            if not chunk:
                break
            encoded_chunks.append(base64.b64encode(chunk))
            pbar.update(len(chunk))

    content_b64 = b"".join(encoded_chunks).decode("utf-8")

    data = {
        "message": commit_message,
        "content": content_b64,
        "branch": BRANCH_NAME,
    }

    print("\nFinalizing upload to GitHub (this may take a moment)...")

    response = requests.put(url, headers=headers, json=data)

    if response.status_code in [200, 201]:
        print("✅ Upload successful!")
    else:
        print(f"❌ Upload failed: {response.status_code} - {response.text}")


if __name__ == "__main__":
    local_path = input("Enter the local file path to upload: ").strip()
    github_path = input("Enter the destination path on GitHub (e.g., folder/filename.ext): ").strip()
    commit_msg = input("Enter the commit message: ").strip()

    upload_with_real_progress(local_path, github_path, commit_msg)

import urllib.request
import json
import time

def test_api():
    url = "http://127.0.0.1:8300/v1/chat/completions"
    headers = {"Content-Type": "application/json"}
    
    # A simple logic question to test the model
    data = {
        "messages": [
            {"role": "system", "content": "You are a helpful AI assistant."},
            {"role": "user", "content": "What is 2 + 2? Please answer in one word."}
        ],
        "max_tokens": 50,
        "temperature": 0.1
    }
    
    req = urllib.request.Request(url, data=json.dumps(data).encode("utf-8"), headers=headers, method="POST")
    
    print(f"Sending request to {url}...")
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            result = json.loads(response.read().decode("utf-8"))
            elapsed = time.time() - t0
            print(f"✅ Success! Received response in {elapsed:.2f} seconds.")
            print("\nResponse:")
            print("-" * 40)
            if "choices" in result:
                print(result["choices"][0]["message"]["content"])
            else:
                print(json.dumps(result, indent=2))
            print("-" * 40)
    except urllib.error.URLError as e:
        print(f"❌ Connection failed: {e}")
    except Exception as e:
        print(f"❌ Error: {e}")

if __name__ == "__main__":
    test_api()

$ErrorActionPreference = "Stop"

Write-Host "1. Running fine-tuning (120 steps)..."
$env:HF_HUB_DISABLE_XET="1"
& ..\..\.venv\Scripts\python.exe train_conciseness.py

Write-Host "2. Starting llama-server in the background..."
$serverProcess = Start-Process -FilePath "C:\Users\danie\.unsloth\llama.cpp\build\bin\Release\llama-server.exe" -ArgumentList "-m C:\Users\danie\program\LUMAX\qwen-4b-concise_gguf\Qwen2.5-3B-Instruct.Q4_K_M.gguf --port 8300" -PassThru -WindowStyle Hidden

Write-Host "Waiting 10 seconds for server to start..."
Start-Sleep -Seconds 10

Write-Host "3. Running benchmark suite..."
& .\.venv\Scripts\python.exe benchmark_run.py --api --quick

Write-Host "4. Cleaning up llama-server..."
Stop-Process -Id $serverProcess.Id -Force

Write-Host "All done!"

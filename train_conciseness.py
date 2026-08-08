import torch
for i in range(1, 8):
    if not hasattr(torch, f"int{i}"):
        setattr(torch, f"int{i}", type(f"int{i}", (), {}))
# pyrefly: ignore [missing-import]
from unsloth import FastLanguageModel
# pyrefly: ignore [missing-import]
from datasets import load_dataset
# pyrefly: ignore [missing-import]
from trl import SFTTrainer
# pyrefly: ignore [missing-import]
from transformers import TrainingArguments

# Configuration
# Note: Unsloth pulls optimized 4-bit weights from HF. If you have the raw safetensors for the 4B model locally,
# update the model_name to point to your local directory.
MODEL_NAME = "unsloth/Qwen2.5-3B-Instruct-bnb-4bit" # Proxy for the 4B core
DATASET_PATH = "conciseness_dataset.jsonl"
MAX_SEQ_LENGTH = 2048
LORA_RANK = 16

def main():
    print(f"Loading {MODEL_NAME} via Unsloth...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name = MODEL_NAME,
        max_seq_length = MAX_SEQ_LENGTH,
        dtype = None,
        load_in_4bit = True,
    )

    # Add LoRA adapters (Knowledge Distillation for Conciseness)
    model = FastLanguageModel.get_peft_model(
        model,
        r = LORA_RANK,
        target_modules = ["q_proj", "k_proj", "v_proj", "o_proj",
                          "gate_proj", "up_proj", "down_proj"],
        lora_alpha = LORA_RANK,
        lora_dropout = 0,
        bias = "none",
        use_gradient_checkpointing = "unsloth",
        random_state = 3407,
        use_rslora = False,
        loftq_config = None,
    )

    print(f"Loading concise reasoning dataset from {DATASET_PATH}...")
    # Map the JSONL messages into the ChatML format expected by Qwen
    def format_chatml(example):
        messages = example["messages"]
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
        return {"text": text}
        
    dataset = load_dataset("json", data_files=DATASET_PATH, split="train")
    dataset = dataset.map(format_chatml)

    trainer = SFTTrainer(
        model = model,
        tokenizer = tokenizer,
        train_dataset = dataset,
        dataset_text_field = "text",
        max_seq_length = MAX_SEQ_LENGTH,
        dataset_num_proc = 2,
        packing = False, # Can make training 5x faster for short sequences.
        args = TrainingArguments(
            per_device_train_batch_size = 2,
            gradient_accumulation_steps = 4,
            warmup_steps = 5,
            max_steps = 120,
            learning_rate = 5e-5,
            fp16 = not torch.cuda.is_bf16_supported(),
            bf16 = torch.cuda.is_bf16_supported(),
            logging_steps = 1,
            optim = "adamw_8bit",
            weight_decay = 0.01,
            lr_scheduler_type = "linear",
            seed = 3407,
            output_dir = "outputs",
            save_strategy = "no",
        ),
    )

    print("Starting QLoRA Fine-Tuning for Conciseness...")
    trainer_stats = trainer.train()

    print("Training complete! Exporting to GGUF format...")
    # Export the LoRA merged with the base model directly to GGUF so it can be injected back into XRLF
    model.save_pretrained_gguf("qwen-4b-concise", tokenizer, quantization_method = "q4_k_m")
    print("Exported to qwen-4b-concise-unsloth.Q4_K_M.gguf")

if __name__ == "__main__":
    main()

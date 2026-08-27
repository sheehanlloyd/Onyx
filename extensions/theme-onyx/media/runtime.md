## All inference is local

Onyx auto-discovers OpenAI-compatible runtimes on your machine:

- **Ollama** — `localhost:11434`
- **LM Studio** — `localhost:1234`
- **llama.cpp** — `localhost:8080`
- **vLLM** — `localhost:8000`

Start any of them and your models appear in the chat model picker within seconds, with size, quantization and context details. Additional endpoints can be added with the `onyx.endpoints` setting.

Nothing you type ever leaves this machine.

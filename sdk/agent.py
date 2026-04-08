import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from anthropic import Anthropic
from firecrawl import FirecrawlApp
from dotenv import load_dotenv
from sdk import trace

load_dotenv(_ROOT / ".env")

client = Anthropic()
firecrawl = FirecrawlApp(api_key=os.getenv("FIRECRAWL_API_KEY"))

@trace(agent_name="research-agent", farol_key="frl_fTfS5MfRTPVoEfCTetpDQz1N", farol_endpoint="https://drmyexzztahpudgrfjsk.supabase.co/functions/v1/ingest")
def research_topic(topic: str, run: dict = None):
    print(f"\n Researching: {topic}\n")
    run["topic"] = topic

    print("Step 1 — Searching the web...")
    search_results = firecrawl.search(topic, limit=3)

    pages = []
    for result in search_results.web:
        with run.span("web_search", type="tool", metadata={"url": result.url}):
            print(f"  Found: {result.url}")
            pages.append(f"URL: {result.url}\nContent: {result.description}")

    combined = "\n\n---\n\n".join(pages)

    print("\nStep 2 — Asking Claude to summarise...\n")
    with run.span(
        "llm_call",
        type="llm",
        metadata={"model": "claude-haiku-4-5-20251001", "step": "llm_summarise"},
    ) as span:
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": f"Based on the following web research, give me a concise 5-bullet summary about: {topic}\n\n{combined}"
                }
            ]
        )
        span.input_tokens = message.usage.input_tokens
        span.output_tokens = message.usage.output_tokens
        run["input_tokens"] = message.usage.input_tokens
        run["output_tokens"] = message.usage.output_tokens

    print("SUMMARY:")
    print(message.content[0].text)

if __name__ == "__main__":
    research_topic("how to reduce LLM costs")

@trace(agent_name="market-agent", farol_key="frl_fTfS5MfRTPVoEfCTetpDQz1N", farol_endpoint="https://drmyexzztahpudgrfjsk.supabase.co/functions/v1/ingest")
def market_research(topic: str, run: dict = None):
    print(f"\n Market research: {topic}\n")
    run["topic"] = topic

    print("Step 1 — Searching the web...")
    search_results = firecrawl.search(topic, limit=3)

    pages = []
    for result in search_results.web:
        with run.span("web_search", type="tool", metadata={"url": result.url}):
            print(f"  Found: {result.url}")
            pages.append(f"URL: {result.url}\nContent: {result.description}")

    combined = "\n\n---\n\n".join(pages)

    print("\nStep 2 — Asking Claude to summarise...\n")
    with run.span(
        "llm_call",
        type="llm",
        metadata={"model": "claude-haiku-4-5-20251001", "step": "llm_analyse"},
    ) as span:
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[
                {
                    "role": "user",
                    "content": f"Based on the following web research, give me a concise 3-bullet market analysis about: {topic}\n\n{combined}"
                }
            ]
        )
        span.input_tokens = message.usage.input_tokens
        span.output_tokens = message.usage.output_tokens
        run["input_tokens"] = message.usage.input_tokens
        run["output_tokens"] = message.usage.output_tokens

    print("ANALYSIS:")
    print(message.content[0].text)

if __name__ == "__main__":
    research_topic("how to reduce LLM costs")
    market_research("Latitude.so agent observability pricing features 2026")
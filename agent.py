import os
from anthropic import Anthropic
from firecrawl import FirecrawlApp
from dotenv import load_dotenv
from sdk import trace

load_dotenv()

client = Anthropic()
firecrawl = FirecrawlApp(api_key=os.getenv("FIRECRAWL_API_KEY"))

@trace(agent_name="research-agent")
def research_topic(topic: str, run: dict = None):
    print(f"\n Researching: {topic}\n")
    run["topic"] = topic

    print("Step 1 — Searching the web...")
    search_results = firecrawl.search(topic, limit=3)

    pages = []
    for result in search_results.web:
        print(f"  Found: {result.url}")
        pages.append(f"URL: {result.url}\nContent: {result.description}")
        run["steps"].append({"step": "web_search", "url": result.url})

    combined = "\n\n---\n\n".join(pages)

    print("\nStep 2 — Asking Claude to summarise...\n")
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

    run["input_tokens"] = message.usage.input_tokens
    run["output_tokens"] = message.usage.output_tokens
    run["steps"].append({"step": "llm_summarise", "model": "claude-haiku-4-5-20251001"})

    print("SUMMARY:")
    print(message.content[0].text)

if __name__ == "__main__":
    research_topic("how to build a developer tool startup")
from farol import trace

@trace(agent_name="research-agent", farol_key="frl_...")
def research_agent(topic, run=None):
    run["topic"] = topic

    # Step 1 — search the web
    with run.span("web_search", type="tool") as span:
        results = search(topic)

    # Step 2 — summarise with Claude
    with run.span("llm_call", type="llm") as span:
        response = llm.call(results)
        span.input_tokens = response.usage.input_tokens
        span.output_tokens = response.usage.output_tokens

    return response.text


# That's it — Farol tracks everything automatically
result = research_agent("how to reduce LLM costs")

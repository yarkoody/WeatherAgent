"""One LLM-judge rubric: does the explanation name the hub's actual top driver?

The top driver comes from the scoring code (the oracle), never from the model under test.
The judge uses the same model as the agent, with a strict JSON verdict, and sees only the
answer text, the hub and the expected driver.
"""

from __future__ import annotations

from typing import Any

import ai
from pydantic import BaseModel, ConfigDict, Field

from app.agent import build_params

FAMILY_WORDS = {
    "winter": "winter weather (snow, ice, extreme cold)",
    "flood": "flooding (inland or coastal flooding, heavy rain)",
    "hurricane": "hurricanes or tropical storms",
    "severe_storm": "severe storms (thunderstorms, tornadoes, strong wind, hail)",
}

JUDGE_PROMPT = """You grade one answer from a weather-risk assistant for logistics hubs.

Hub: {hub_name}
The scoring code says this hub's top driver (largest share of expected disruption days) is: {family} = {family_words}, {share}% of disruption days.

Rubric: does the answer name {family_words} as the main or largest driver of this hub's risk?
- pass = true if the answer clearly identifies that hazard family (any clear synonym counts) as the main, largest or leading driver.
- pass = false if it names a different family as the main driver, gives no main driver, or only lists families without saying which leads.
Grade only this rubric, not style or other content. Reply with the JSON verdict.

Answer to grade:
<answer>
{answer}
</answer>"""


class Verdict(BaseModel):
    model_config = ConfigDict(extra="forbid")
    passed: bool = Field(description="True if the answer names the expected top driver as the main driver.")
    reason: str = Field(description="One short sentence explaining the verdict.")


async def judge_top_driver(
    model: ai.Model, answer_text: str, hub_name: str, family: str, share: float
) -> dict[str, Any]:
    """Return {"passed", "reason", "input_tokens", "output_tokens"}; passed is None if the judge reply was invalid."""
    prompt = JUDGE_PROMPT.format(
        hub_name=hub_name, family=family, family_words=FAMILY_WORDS[family], share=share, answer=answer_text
    )
    async with ai.stream(model, [ai.user_message(prompt)], output_type=Verdict, params=build_params()) as stream:
        async for _ in stream:
            pass
    usage = stream.message.usage
    tokens = {
        "input_tokens": usage.input_tokens if usage else 0,
        "output_tokens": usage.output_tokens if usage else 0,
    }
    try:
        verdict = stream.message.get_output(Verdict)
    except ValueError:
        return {"passed": None, "reason": "judge reply was not a valid verdict", **tokens}
    return {"passed": verdict.passed, "reason": verdict.reason, **tokens}

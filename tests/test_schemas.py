"""The shared contracts must produce strict JSON schemas (OpenAI structured outputs)."""

import pytest
from openai.lib._pydantic import to_strict_json_schema
from pydantic import ValidationError

from app import schemas


def _all_objects(schema: dict):
    """Yield every object-typed node in a JSON schema, including $defs."""
    stack = [schema]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get("type") == "object":
                yield node
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)


@pytest.mark.parametrize("model", [schemas.AgentAnswer, schemas.WhatIfInput, schemas.ChatRequest])
def test_schema_is_strict(model):
    schema = model.model_json_schema()
    for obj in _all_objects(schema):
        assert obj.get("additionalProperties") is False, obj


def test_agent_answer_accepted_by_openai_strict_converter():
    strict = to_strict_json_schema(schemas.AgentAnswer)
    assert set(strict["required"]) == set(schemas.AgentAnswer.model_fields)


def test_agent_answer_rejects_extra_fields():
    with pytest.raises(ValidationError):
        schemas.AgentAnswer.model_validate(
            {
                "answer": "x", "hubs": [], "ranking": None, "figures": [],
                "assumptions": [], "uncertainty": "", "data_available": True,
                "in_scope": True, "extra": 1,
            }
        )


@pytest.mark.parametrize("message", ["", "x" * 2001])
def test_chat_request_message_length(message):
    with pytest.raises(ValidationError):
        schemas.ChatRequest(session_id=None, message=message)

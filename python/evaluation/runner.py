"""Isolated DeepEval runner. Company model calls go through the TS Pi gateway
over a bounded stdio protocol, without API keys or database access in Python."""
import os
os.environ.update(DEEPEVAL_TELEMETRY_OPT_OUT='YES', DEEPEVAL_DISABLE_PROGRESS_BAR='1',
                  CONFIDENT_API_KEY='', DEEPEVAL_DISABLE_DOTENV='1')
import json
import sys
import importlib.metadata
import socket

def no_network(*args, **kwargs):
    raise RuntimeError('EVALUATOR_NETWORK_DISABLED')
socket.socket.connect = no_network
socket.create_connection = no_network

from deepeval.models import DeepEvalBaseLLM
from deepeval.metrics import FaithfulnessMetric, AnswerRelevancyMetric, GEval
from deepeval.test_case import LLMTestCase, LLMTestCaseParams


class CompanyJudge(DeepEvalBaseLLM):
    def __init__(self, profile):
        self.profile = profile
        self.sequence = 0
        super().__init__(model=profile['model'])

    def load_model(self):
        return self

    def get_model_name(self):
        return self.profile['model'] + '@' + self.profile['revision']

    def supports_log_probs(self):
        return False

    def generate(self, prompt, schema=None, **kwargs):
        self.sequence += 1
        print(json.dumps(dict(type='judge', seq=self.sequence, prompt=prompt,
                              schema=schema.model_json_schema() if schema else None)), flush=True)
        response = json.loads(sys.stdin.readline())
        if response.get('seq') != self.sequence or response.get('error'):
            raise RuntimeError('JUDGE_FAILED')
        text = response['text']
        return schema.model_validate_json(text) if schema else text

    async def a_generate(self, prompt, schema=None, **kwargs):
        return self.generate(prompt, schema, **kwargs)


def run(task):
    judge = CompanyJudge(task['judge'])
    results = []
    for case in task['cases']:
        metrics = [
            ('faithfulness', FaithfulnessMetric(model=judge, async_mode=False, include_reason=True)),
            ('relevancy', AnswerRelevancyMetric(model=judge, async_mode=False, include_reason=True)),
            ('coverage', GEval(name='Necessary fact coverage', model=judge, async_mode=False,
                evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT, LLMTestCaseParams.EXPECTED_OUTPUT],
                evaluation_steps=['Read the necessary facts in expected output.', 'Score how completely and correctly the answer covers all necessary facts, considering their conditions and time. Do not reward verbosity or invented facts.'])),
            ('forbidden', GEval(name='Forbidden conclusion avoidance', model=judge, async_mode=False,
                evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT, LLMTestCaseParams.EXPECTED_OUTPUT],
                evaluation_steps=['Read the forbidden conclusions in expected output.', 'Give the highest score only if the answer asserts none of the forbidden conclusions, including paraphrases or conditionally invalid conclusions. If there are no forbidden conclusions, give full credit.'])),
        ]
        scores = []
        for name, metric in metrics:
            expected = case['forbiddenFacts'] if name == 'forbidden' else case['expectedFacts']
            test = LLMTestCase(input=case['question'], actual_output=case['answer'],
                               expected_output=json.dumps(expected, ensure_ascii=False), retrieval_context=case['context'])
            try:
                metric.measure(test)
                if metric.score is None:
                    raise ValueError('MISSING_SCORE')
                scores.append(dict(name=name, scoreBps=round(metric.score * 10000), reason=metric.reason or '', state='complete'))
            except Exception as exc:
                scores.append(dict(name=name, scoreBps=None, reason=type(exc).__name__, state='failed'))
        results.append(dict(caseId=case['id'], inputHash=case['inputHash'], metrics=scores))
    print(json.dumps(dict(type='report', binding=task['binding'], cases=results,
                         runtime=dict(deepeval=importlib.metadata.version('deepeval'), python=sys.version.split()[0]))), flush=True)


if __name__ == '__main__':
    run(json.loads(sys.stdin.readline()))

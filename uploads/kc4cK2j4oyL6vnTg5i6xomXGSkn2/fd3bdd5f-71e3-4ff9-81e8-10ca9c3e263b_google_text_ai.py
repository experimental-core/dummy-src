import time
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain.messages import HumanMessage, AIMessage
from ai.base import BaseAI
from ..contextprovider import ContextProvider
from config import CONFIG
from utils.google_citations import get_citations_from_grounding

class GeminiTextAI(BaseAI):
    MAPPINGS = CONFIG.AI_MAPPINGS

    def __init__(
        self,
        model_name,
        system_prompt=None,
        temperature=0.7,
        top_p=1.0,
        top_k=40,
    ):
        self.model_name = model_name
        self.details = self.MAPPINGS.get(model_name, {})
        self.model = ChatGoogleGenerativeAI(
            model=self.details.get("model_id"),
            temperature=self.details.get("temperature", temperature),
            top_p=self.details.get("top_p", top_p),
            top_k=self.details.get("top_k", top_k),
        )
        self.model = self.model.bind_tools([{"google_search": {}}, {"url_context": {}}]) 
        self.system_prompt = self.details.get("system_prompt", system_prompt)

    def stream(self, payload):
        start_time = time.time()
        user = payload.get("user", {})
        user_id = user.get("user_id", None)
        chat_id = payload.get("chat_id", None)
        prompt = payload.get("prompt", "")

        yield self._send_step("info", "Summarizing context")
        ctx = ContextProvider.get(self.model_name, user_id, chat_id, self.system_prompt)
        context = ctx.build_context(prompt, files=payload.get("files", []))
        ai_response = ""
        yield self._start()

        started = False

        grounding_metadatas = []
        for chunk in self.model.stream(context):
            if chunk.response_metadata.get("grounding_metadata", False):
                grounding_metadatas.append(chunk.response_metadata["grounding_metadata"]) 
            if not started:
                yield self._started()
                started = True

            if isinstance(chunk.content, list):
                for block in chunk.content:
                    if isinstance(block, dict) and "text" in block:
                        ai_response += block["text"]
                        yield self._text(block["text"])
            else:
                ai_response += str(chunk.content)
                yield self._text(str(chunk.content))

        ctx.append(AIMessage(content=ai_response))

        if grounding_metadatas:
            yield self._send_step("fetch_source_information", "Preparing Citations")
            for grounding_metadata in grounding_metadatas:
                if grounding_metadata.get("grounding_chunks", False):
                    yield self._source(get_citations_from_grounding(grounding_metadata["grounding_chunks"], grounding_metadata.get("grounding_supports", [])))

        end_time = time.time()
        duration = end_time - start_time
        yield self._send_duration(duration)
        yield self._end()

    def invoke(self, payload):
        prompt = payload.get("prompt", "")
        content_parts=[]
        if prompt:
            content_parts.append({
                "type": "text",
                "text": prompt
            })
        for file in payload.get("files", []):
            file_uri = file.get("genai_file", {}).get("uri", None)
            if file_uri:
                content_parts.append({
                    "type": "file",
                    "file_id": file_uri,
                    "mime_type": file.get("genai_file", {}).get("mime_type", None),
                })

        return self.model.invoke([HumanMessage(content=content_parts)])

    def with_structured_output(self, *args, **kwargs):
        return self.model.with_structured_output(*args, **kwargs)
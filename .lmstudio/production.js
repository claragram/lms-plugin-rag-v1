"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/config.ts
var import_sdk, configSchematics;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    import_sdk = require("@lmstudio/sdk");
    configSchematics = (0, import_sdk.createConfigSchematics)().field(
      "retrievalLimit",
      "numeric",
      {
        int: true,
        min: 1,
        displayName: "Retrieval Limit",
        subtitle: "When retrieval is triggered, this is the maximum number of chunks to return.",
        slider: { min: 1, max: 10, step: 1 }
      },
      3
    ).field(
      "retrievalAffinityThreshold",
      "numeric",
      {
        min: 0,
        max: 1,
        displayName: "Retrieval Affinity Threshold",
        subtitle: "The minimum similarity score for a chunk to be considered relevant.",
        slider: { min: 0, max: 1, step: 0.01 }
      },
      0.5
    ).build();
  }
});

// src/promptPreprocessor.ts
async function preprocess(ctl, userMessage) {
  const userPrompt = userMessage.getText();
  const history = await ctl.pullHistory();
  history.append(userMessage);
  const newFiles = userMessage.getFiles(ctl.client).filter((f) => f.type !== "image");
  const files = history.getAllFiles(ctl.client).filter((f) => f.type !== "image");
  if (newFiles.length > 0) {
    const strategy = await chooseContextInjectionStrategy(ctl, userPrompt, newFiles);
    if (strategy === "inject-full-content") {
      return await prepareDocumentContextInjection(ctl, userMessage);
    } else if (strategy === "retrieval") {
      return await prepareRetrievalResultsContextInjection(ctl, userPrompt, files);
    }
  } else if (files.length > 0) {
    return await prepareRetrievalResultsContextInjection(ctl, userPrompt, files);
  }
  return userMessage;
}
async function prepareRetrievalResultsContextInjection(ctl, originalUserPrompt, files) {
  const pluginConfig = ctl.getPluginConfig(configSchematics);
  const retrievalLimit = pluginConfig.get("retrievalLimit");
  const retrievalAffinityThreshold = pluginConfig.get("retrievalAffinityThreshold");
  const statusSteps = /* @__PURE__ */ new Map();
  const retrievingStatus = ctl.createStatus({
    status: "loading",
    text: `Loading an embedding model for retrieval...`
  });
  const model = await ctl.client.embedding.model("nomic-ai/nomic-embed-text-v1.5-GGUF", {
    signal: ctl.abortSignal
  });
  retrievingStatus.setState({
    status: "loading",
    text: `Retrieving relevant citations for user query...`
  });
  const result = await ctl.client.files.retrieve(originalUserPrompt, files, {
    embeddingModel: model,
    // Affinity threshold: 0.6 not implemented
    limit: retrievalLimit,
    signal: ctl.abortSignal,
    onFileProcessList(filesToProcess) {
      for (const file of filesToProcess) {
        statusSteps.set(
          file,
          retrievingStatus.addSubStatus({
            status: "waiting",
            text: `Process ${file.name} for retrieval`
          })
        );
      }
    },
    onFileProcessingStart(file) {
      statusSteps.get(file).setState({ status: "loading", text: `Processing ${file.name} for retrieval` });
    },
    onFileProcessingEnd(file) {
      statusSteps.get(file).setState({ status: "done", text: `Processed ${file.name} for retrieval` });
    },
    onFileProcessingStepProgress(file, step, progressInStep) {
      const verb = step === "loading" ? "Loading" : step === "chunking" ? "Chunking" : "Embedding";
      statusSteps.get(file).setState({
        status: "loading",
        text: `${verb} ${file.name} for retrieval (${(progressInStep * 100).toFixed(1)}%)`
      });
    }
  });
  result.entries = result.entries.filter((entry) => entry.score > retrievalAffinityThreshold);
  let processedContent = "";
  const numRetrievals = result.entries.length;
  if (numRetrievals > 0) {
    retrievingStatus.setState({
      status: "done",
      text: `Retrieved ${numRetrievals} relevant citations for user query`
    });
    ctl.debug("Retrieval results", result);
    const prefix = "The following citations were found in the files provided by the user:\n\n";
    processedContent += prefix;
    let citationNumber = 1;
    result.entries.forEach((result2) => {
      const completeText = result2.content;
      processedContent += `Citation ${citationNumber}: "${completeText}"

`;
      citationNumber++;
    });
    await ctl.addCitations(result);
    const suffix = `Use the citations above to respond to the user query, only if they are relevant. Otherwise, respond to the best of your ability without them.

User Query:

${originalUserPrompt}`;
    processedContent += suffix;
  } else {
    retrievingStatus.setState({
      status: "canceled",
      text: `No relevant citations found for user query`
    });
    ctl.debug("No relevant citations found for user query");
    const noteAboutNoRetrievalResultsFound = `Important: No citations were found in the user files for the user query. In less than one sentence, inform the user of this. Then respond to the query to the best of your ability.`;
    processedContent = noteAboutNoRetrievalResultsFound + `

User Query:

${originalUserPrompt}`;
  }
  ctl.debug("Processed content", processedContent);
  return processedContent;
}
async function prepareDocumentContextInjection(ctl, input) {
  const documentInjectionSnippets = /* @__PURE__ */ new Map();
  const files = input.consumeFiles(ctl.client, (file) => file.type !== "image");
  for (const file of files) {
    const { content } = await ctl.client.files.parseDocument(file, {
      signal: ctl.abortSignal
    });
    ctl.debug(import_sdk2.text`
      Strategy: inject-full-content. Injecting full content of file '${file}' into the
      context. Length: ${content.length}.
    `);
    documentInjectionSnippets.set(file, content);
  }
  let formattedFinalUserPrompt = "";
  if (documentInjectionSnippets.size > 0) {
    formattedFinalUserPrompt += "This is a Enriched Context Generation scenario.\n\nThe following content was found in the files provided by the user.\n";
    for (const [fileHandle, snippet] of documentInjectionSnippets) {
      formattedFinalUserPrompt += `

** ${fileHandle.name} full content **

${snippet}

** end of ${fileHandle.name} **

`;
    }
    formattedFinalUserPrompt += `Based on the content above, please provide a response to the user query.

User query: ${input.getText()}`;
  }
  input.replaceText(formattedFinalUserPrompt);
  return input;
}
async function getEffectiveContextFormatted(ctx, model, ctl) {
  try {
    return await model.applyPromptTemplate(ctx);
  } catch (e) {
    const hasAnyUserMessage = ctx.getMessagesArray().some((message) => message.getRole() === "user");
    if (!hasAnyUserMessage) {
      const placeholderUserMessageContent = "?";
      ctl.debug(import_sdk2.text`
        Failed to apply prompt template on context with no user messages. Retrying with placeholder
        user message.
      `);
      const measurementContext = ctx.withAppended("user", placeholderUserMessageContent);
      return await model.applyPromptTemplate(measurementContext);
    }
    throw e;
  }
}
async function measureContextWindow(ctx, model, ctl) {
  const currentContextFormatted = await getEffectiveContextFormatted(ctx, model, ctl);
  const totalTokensInContext = await model.countTokens(currentContextFormatted);
  const modelContextLength = await model.getContextLength();
  const modelRemainingContextLength = modelContextLength - totalTokensInContext;
  const contextOccupiedPercent = totalTokensInContext / modelContextLength * 100;
  return {
    totalTokensInContext,
    modelContextLength,
    modelRemainingContextLength,
    contextOccupiedPercent
  };
}
async function chooseContextInjectionStrategy(ctl, originalUserPrompt, files) {
  const status = ctl.createStatus({
    status: "loading",
    text: `Deciding how to handle the document(s)...`
  });
  const tokenSource = await ctl.tokenSource();
  let model = null;
  if (tokenSource.identifier !== ENTERPRISE_REMOTE_SERVER_PLUGIN_IDENTIFIER) {
    model = await ctl.client.llm.model();
  }
  const chat = await ctl.pullHistory();
  let totalTokensInContext;
  let modelContextLength;
  if (model === null) {
    totalTokensInContext = Math.ceil(chat.toString().length / APPROXIMATE_CHARACTERS_PER_TOKEN);
    modelContextLength = ENTERPRISE_REMOTE_SERVER_CONTEXT_LENGTH_HEURISTIC;
  } else {
    const contextWindow = await measureContextWindow(chat, model, ctl);
    totalTokensInContext = contextWindow.totalTokensInContext;
    modelContextLength = contextWindow.modelContextLength;
  }
  const modelRemainingContextLength = modelContextLength - totalTokensInContext;
  const contextOccupiedPercent = totalTokensInContext / modelContextLength * 100;
  ctl.debug(
    `Context measurement result:

	Total tokens in context: ${totalTokensInContext}
	Model context length: ${modelContextLength}
	Model remaining context length: ${modelRemainingContextLength}
	Context occupied percent: ${contextOccupiedPercent.toFixed(2)}%
`
  );
  let totalFileTokenCount = 0;
  let totalReadTime = 0;
  let totalTokenizeTime = 0;
  for (const file of files) {
    const startTime = performance.now();
    const loadingStatus = status.addSubStatus({
      status: "loading",
      text: `Loading parser for ${file.name}...`
    });
    let actionProgressing = "Reading";
    let parserIndicator = "";
    const { content } = await ctl.client.files.parseDocument(file, {
      signal: ctl.abortSignal,
      onParserLoaded: (parser) => {
        loadingStatus.setState({
          status: "loading",
          text: `${parser.library} loaded for ${file.name}...`
        });
        if (parser.library !== "builtIn") {
          actionProgressing = "Parsing";
          parserIndicator = ` with ${parser.library}`;
        }
      },
      onProgress: (progress) => {
        loadingStatus.setState({
          status: "loading",
          text: `${actionProgressing} file ${file.name}${parserIndicator}... (${(progress * 100).toFixed(2)}%)`
        });
      }
    });
    loadingStatus.remove();
    totalReadTime += performance.now() - startTime;
    const startTokenizeTime = performance.now();
    if (model === null) {
      totalFileTokenCount += Math.ceil(content.length / APPROXIMATE_CHARACTERS_PER_TOKEN);
    } else {
      totalFileTokenCount += await model.countTokens(content);
    }
    totalTokenizeTime += performance.now() - startTokenizeTime;
    if (totalFileTokenCount > modelRemainingContextLength) {
      break;
    }
  }
  ctl.debug(`Total file read time: ${totalReadTime.toFixed(2)} ms`);
  ctl.debug(`Total tokenize time: ${totalTokenizeTime.toFixed(2)} ms`);
  ctl.debug(`Original User Prompt: ${originalUserPrompt}`);
  let userPromptTokenCount;
  if (model === null) {
    userPromptTokenCount = Math.ceil(originalUserPrompt.length / APPROXIMATE_CHARACTERS_PER_TOKEN);
  } else {
    userPromptTokenCount = (await model.tokenize(originalUserPrompt)).length;
  }
  const totalFilePlusPromptTokenCount = totalFileTokenCount + userPromptTokenCount;
  const contextOccupiedFraction = contextOccupiedPercent / 100;
  const targetContextUsePercent = 0.7;
  const targetContextUsage = targetContextUsePercent * (1 - contextOccupiedFraction);
  const availableContextTokens = Math.floor(modelRemainingContextLength * targetContextUsage);
  ctl.debug("Strategy Calculation:");
  ctl.debug(`	Total Tokens in All Files: ${totalFileTokenCount}`);
  ctl.debug(`	Total Tokens in User Prompt: ${userPromptTokenCount}`);
  ctl.debug(`	Model Context Remaining: ${modelRemainingContextLength} tokens`);
  ctl.debug(`	Context Occupied: ${contextOccupiedPercent.toFixed(2)}%`);
  ctl.debug(`	Available Tokens: ${availableContextTokens}
`);
  if (totalFilePlusPromptTokenCount > availableContextTokens) {
    const chosenStrategy2 = "retrieval";
    ctl.debug(
      `Chosen context injection strategy: '${chosenStrategy2}'. Total file + prompt token count: ${totalFilePlusPromptTokenCount} > ${targetContextUsage * 100}% * available context tokens: ${availableContextTokens}`
    );
    status.setState({
      status: "done",
      text: `Chosen context injection strategy: '${chosenStrategy2}'. Retrieval is optimal for the size of content provided`
    });
    return chosenStrategy2;
  }
  const chosenStrategy = "inject-full-content";
  status.setState({
    status: "done",
    text: `Chosen context injection strategy: '${chosenStrategy}'. All content can fit into the context`
  });
  return chosenStrategy;
}
var import_sdk2, ENTERPRISE_REMOTE_SERVER_PLUGIN_IDENTIFIER, ENTERPRISE_REMOTE_SERVER_CONTEXT_LENGTH_HEURISTIC, APPROXIMATE_CHARACTERS_PER_TOKEN;
var init_promptPreprocessor = __esm({
  "src/promptPreprocessor.ts"() {
    "use strict";
    import_sdk2 = require("@lmstudio/sdk");
    init_config();
    ENTERPRISE_REMOTE_SERVER_PLUGIN_IDENTIFIER = "lmstudio/remote-server";
    ENTERPRISE_REMOTE_SERVER_CONTEXT_LENGTH_HEURISTIC = 1e5;
    APPROXIMATE_CHARACTERS_PER_TOKEN = 4;
  }
});

// src/index.ts
var src_exports = {};
__export(src_exports, {
  main: () => main
});
async function main(context) {
  context.withConfigSchematics(configSchematics);
  context.withPromptPreprocessor(preprocess);
}
var init_src = __esm({
  "src/index.ts"() {
    "use strict";
    init_config();
    init_promptPreprocessor();
  }
});

// .lmstudio/entry.ts
var import_sdk3 = require("@lmstudio/sdk");
var clientIdentifier = process.env.LMS_PLUGIN_CLIENT_IDENTIFIER;
var clientPasskey = process.env.LMS_PLUGIN_CLIENT_PASSKEY;
var baseUrl = process.env.LMS_PLUGIN_BASE_URL;
var client = new import_sdk3.LMStudioClient({
  clientIdentifier,
  clientPasskey,
  baseUrl
});
globalThis.__LMS_PLUGIN_CONTEXT = true;
var predictionLoopHandlerSet = false;
var promptPreprocessorSet = false;
var configSchematicsSet = false;
var globalConfigSchematicsSet = false;
var toolsProviderSet = false;
var generatorSet = false;
var selfRegistrationHost = client.plugins.getSelfRegistrationHost();
var pluginContext = {
  withPredictionLoopHandler: (generate) => {
    if (predictionLoopHandlerSet) {
      throw new Error("PredictionLoopHandler already registered");
    }
    if (toolsProviderSet) {
      throw new Error("PredictionLoopHandler cannot be used with a tools provider");
    }
    predictionLoopHandlerSet = true;
    selfRegistrationHost.setPredictionLoopHandler(generate);
    return pluginContext;
  },
  withPromptPreprocessor: (preprocess2) => {
    if (promptPreprocessorSet) {
      throw new Error("PromptPreprocessor already registered");
    }
    promptPreprocessorSet = true;
    selfRegistrationHost.setPromptPreprocessor(preprocess2);
    return pluginContext;
  },
  withConfigSchematics: (configSchematics2) => {
    if (configSchematicsSet) {
      throw new Error("Config schematics already registered");
    }
    configSchematicsSet = true;
    selfRegistrationHost.setConfigSchematics(configSchematics2);
    return pluginContext;
  },
  withGlobalConfigSchematics: (globalConfigSchematics) => {
    if (globalConfigSchematicsSet) {
      throw new Error("Global config schematics already registered");
    }
    globalConfigSchematicsSet = true;
    selfRegistrationHost.setGlobalConfigSchematics(globalConfigSchematics);
    return pluginContext;
  },
  withToolsProvider: (toolsProvider) => {
    if (toolsProviderSet) {
      throw new Error("Tools provider already registered");
    }
    if (predictionLoopHandlerSet) {
      throw new Error("Tools provider cannot be used with a predictionLoopHandler");
    }
    toolsProviderSet = true;
    selfRegistrationHost.setToolsProvider(toolsProvider);
    return pluginContext;
  },
  withGenerator: (generator) => {
    if (generatorSet) {
      throw new Error("Generator already registered");
    }
    generatorSet = true;
    selfRegistrationHost.setGenerator(generator);
    return pluginContext;
  }
};
Promise.resolve().then(() => (init_src(), src_exports)).then(async (module2) => {
  return await module2.main(pluginContext);
}).then(() => {
  selfRegistrationHost.initCompleted();
}).catch((error) => {
  console.error("Failed to execute the main function of the plugin.");
  console.error(error);
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL2NvbmZpZy50cyIsICIuLi9zcmMvcHJvbXB0UHJlcHJvY2Vzc29yLnRzIiwgIi4uL3NyYy9pbmRleC50cyIsICJlbnRyeS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiaW1wb3J0IHsgY3JlYXRlQ29uZmlnU2NoZW1hdGljcyB9IGZyb20gXCJAbG1zdHVkaW8vc2RrXCI7XG5cbmV4cG9ydCBjb25zdCBjb25maWdTY2hlbWF0aWNzID0gY3JlYXRlQ29uZmlnU2NoZW1hdGljcygpXG4gIC5maWVsZChcbiAgICBcInJldHJpZXZhbExpbWl0XCIsXG4gICAgXCJudW1lcmljXCIsXG4gICAge1xuICAgICAgaW50OiB0cnVlLFxuICAgICAgbWluOiAxLFxuICAgICAgZGlzcGxheU5hbWU6IFwiUmV0cmlldmFsIExpbWl0XCIsXG4gICAgICBzdWJ0aXRsZTogXCJXaGVuIHJldHJpZXZhbCBpcyB0cmlnZ2VyZWQsIHRoaXMgaXMgdGhlIG1heGltdW0gbnVtYmVyIG9mIGNodW5rcyB0byByZXR1cm4uXCIsXG4gICAgICBzbGlkZXI6IHsgbWluOiAxLCBtYXg6IDEwLCBzdGVwOiAxIH0sXG4gICAgfSxcbiAgICAzLFxuICApXG4gIC5maWVsZChcbiAgICBcInJldHJpZXZhbEFmZmluaXR5VGhyZXNob2xkXCIsXG4gICAgXCJudW1lcmljXCIsXG4gICAge1xuICAgICAgbWluOiAwLjAsXG4gICAgICBtYXg6IDEuMCxcbiAgICAgIGRpc3BsYXlOYW1lOiBcIlJldHJpZXZhbCBBZmZpbml0eSBUaHJlc2hvbGRcIixcbiAgICAgIHN1YnRpdGxlOiBcIlRoZSBtaW5pbXVtIHNpbWlsYXJpdHkgc2NvcmUgZm9yIGEgY2h1bmsgdG8gYmUgY29uc2lkZXJlZCByZWxldmFudC5cIixcbiAgICAgIHNsaWRlcjogeyBtaW46IDAuMCwgbWF4OiAxLjAsIHN0ZXA6IDAuMDEgfSxcbiAgICB9LFxuICAgIDAuNSxcbiAgKVxuICAuYnVpbGQoKTtcbiIsICJpbXBvcnQge1xuICB0ZXh0LFxuICB0eXBlIENoYXQsXG4gIHR5cGUgQ2hhdE1lc3NhZ2UsXG4gIHR5cGUgRmlsZUhhbmRsZSxcbiAgdHlwZSBMTE1EeW5hbWljSGFuZGxlLFxuICB0eXBlIFByZWRpY3Rpb25Qcm9jZXNzU3RhdHVzQ29udHJvbGxlcixcbiAgdHlwZSBQcm9tcHRQcmVwcm9jZXNzb3JDb250cm9sbGVyLFxufSBmcm9tIFwiQGxtc3R1ZGlvL3Nka1wiO1xuaW1wb3J0IHsgY29uZmlnU2NoZW1hdGljcyB9IGZyb20gXCIuL2NvbmZpZ1wiO1xuXG5jb25zdCBFTlRFUlBSSVNFX1JFTU9URV9TRVJWRVJfUExVR0lOX0lERU5USUZJRVIgPSBcImxtc3R1ZGlvL3JlbW90ZS1zZXJ2ZXJcIjtcbmNvbnN0IEVOVEVSUFJJU0VfUkVNT1RFX1NFUlZFUl9DT05URVhUX0xFTkdUSF9IRVVSSVNUSUMgPSAxMDBfMDAwO1xuY29uc3QgQVBQUk9YSU1BVEVfQ0hBUkFDVEVSU19QRVJfVE9LRU4gPSA0O1xuXG50eXBlIERvY3VtZW50Q29udGV4dEluamVjdGlvblN0cmF0ZWd5ID0gXCJub25lXCIgfCBcImluamVjdC1mdWxsLWNvbnRlbnRcIiB8IFwicmV0cmlldmFsXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBwcmVwcm9jZXNzKGN0bDogUHJvbXB0UHJlcHJvY2Vzc29yQ29udHJvbGxlciwgdXNlck1lc3NhZ2U6IENoYXRNZXNzYWdlKSB7XG4gIGNvbnN0IHVzZXJQcm9tcHQgPSB1c2VyTWVzc2FnZS5nZXRUZXh0KCk7XG4gIGNvbnN0IGhpc3RvcnkgPSBhd2FpdCBjdGwucHVsbEhpc3RvcnkoKTtcbiAgaGlzdG9yeS5hcHBlbmQodXNlck1lc3NhZ2UpO1xuICBjb25zdCBuZXdGaWxlcyA9IHVzZXJNZXNzYWdlLmdldEZpbGVzKGN0bC5jbGllbnQpLmZpbHRlcihmID0+IGYudHlwZSAhPT0gXCJpbWFnZVwiKTtcbiAgY29uc3QgZmlsZXMgPSBoaXN0b3J5LmdldEFsbEZpbGVzKGN0bC5jbGllbnQpLmZpbHRlcihmID0+IGYudHlwZSAhPT0gXCJpbWFnZVwiKTtcblxuICBpZiAobmV3RmlsZXMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHN0cmF0ZWd5ID0gYXdhaXQgY2hvb3NlQ29udGV4dEluamVjdGlvblN0cmF0ZWd5KGN0bCwgdXNlclByb21wdCwgbmV3RmlsZXMpO1xuICAgIGlmIChzdHJhdGVneSA9PT0gXCJpbmplY3QtZnVsbC1jb250ZW50XCIpIHtcbiAgICAgIHJldHVybiBhd2FpdCBwcmVwYXJlRG9jdW1lbnRDb250ZXh0SW5qZWN0aW9uKGN0bCwgdXNlck1lc3NhZ2UpO1xuICAgIH0gZWxzZSBpZiAoc3RyYXRlZ3kgPT09IFwicmV0cmlldmFsXCIpIHtcbiAgICAgIHJldHVybiBhd2FpdCBwcmVwYXJlUmV0cmlldmFsUmVzdWx0c0NvbnRleHRJbmplY3Rpb24oY3RsLCB1c2VyUHJvbXB0LCBmaWxlcyk7XG4gICAgfVxuICB9IGVsc2UgaWYgKGZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4gYXdhaXQgcHJlcGFyZVJldHJpZXZhbFJlc3VsdHNDb250ZXh0SW5qZWN0aW9uKGN0bCwgdXNlclByb21wdCwgZmlsZXMpO1xuICB9XG5cbiAgcmV0dXJuIHVzZXJNZXNzYWdlO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlUmV0cmlldmFsUmVzdWx0c0NvbnRleHRJbmplY3Rpb24oXG4gIGN0bDogUHJvbXB0UHJlcHJvY2Vzc29yQ29udHJvbGxlcixcbiAgb3JpZ2luYWxVc2VyUHJvbXB0OiBzdHJpbmcsXG4gIGZpbGVzOiBBcnJheTxGaWxlSGFuZGxlPixcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHBsdWdpbkNvbmZpZyA9IGN0bC5nZXRQbHVnaW5Db25maWcoY29uZmlnU2NoZW1hdGljcyk7XG4gIGNvbnN0IHJldHJpZXZhbExpbWl0ID0gcGx1Z2luQ29uZmlnLmdldChcInJldHJpZXZhbExpbWl0XCIpO1xuICBjb25zdCByZXRyaWV2YWxBZmZpbml0eVRocmVzaG9sZCA9IHBsdWdpbkNvbmZpZy5nZXQoXCJyZXRyaWV2YWxBZmZpbml0eVRocmVzaG9sZFwiKTtcblxuICAvLyBwcm9jZXNzIGZpbGVzIGlmIG5lY2Vzc2FyeVxuXG4gIGNvbnN0IHN0YXR1c1N0ZXBzID0gbmV3IE1hcDxGaWxlSGFuZGxlLCBQcmVkaWN0aW9uUHJvY2Vzc1N0YXR1c0NvbnRyb2xsZXI+KCk7XG5cbiAgY29uc3QgcmV0cmlldmluZ1N0YXR1cyA9IGN0bC5jcmVhdGVTdGF0dXMoe1xuICAgIHN0YXR1czogXCJsb2FkaW5nXCIsXG4gICAgdGV4dDogYExvYWRpbmcgYW4gZW1iZWRkaW5nIG1vZGVsIGZvciByZXRyaWV2YWwuLi5gLFxuICB9KTtcbiAgY29uc3QgbW9kZWwgPSBhd2FpdCBjdGwuY2xpZW50LmVtYmVkZGluZy5tb2RlbChcIm5vbWljLWFpL25vbWljLWVtYmVkLXRleHQtdjEuNS1HR1VGXCIsIHtcbiAgICBzaWduYWw6IGN0bC5hYm9ydFNpZ25hbCxcbiAgfSk7XG4gIHJldHJpZXZpbmdTdGF0dXMuc2V0U3RhdGUoe1xuICAgIHN0YXR1czogXCJsb2FkaW5nXCIsXG4gICAgdGV4dDogYFJldHJpZXZpbmcgcmVsZXZhbnQgY2l0YXRpb25zIGZvciB1c2VyIHF1ZXJ5Li4uYCxcbiAgfSk7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGN0bC5jbGllbnQuZmlsZXMucmV0cmlldmUob3JpZ2luYWxVc2VyUHJvbXB0LCBmaWxlcywge1xuICAgIGVtYmVkZGluZ01vZGVsOiBtb2RlbCxcbiAgICAvLyBBZmZpbml0eSB0aHJlc2hvbGQ6IDAuNiBub3QgaW1wbGVtZW50ZWRcbiAgICBsaW1pdDogcmV0cmlldmFsTGltaXQsXG4gICAgc2lnbmFsOiBjdGwuYWJvcnRTaWduYWwsXG4gICAgb25GaWxlUHJvY2Vzc0xpc3QoZmlsZXNUb1Byb2Nlc3MpIHtcbiAgICAgIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlc1RvUHJvY2Vzcykge1xuICAgICAgICBzdGF0dXNTdGVwcy5zZXQoXG4gICAgICAgICAgZmlsZSxcbiAgICAgICAgICByZXRyaWV2aW5nU3RhdHVzLmFkZFN1YlN0YXR1cyh7XG4gICAgICAgICAgICBzdGF0dXM6IFwid2FpdGluZ1wiLFxuICAgICAgICAgICAgdGV4dDogYFByb2Nlc3MgJHtmaWxlLm5hbWV9IGZvciByZXRyaWV2YWxgLFxuICAgICAgICAgIH0pLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0sXG4gICAgb25GaWxlUHJvY2Vzc2luZ1N0YXJ0KGZpbGUpIHtcbiAgICAgIHN0YXR1c1N0ZXBzXG4gICAgICAgIC5nZXQoZmlsZSkhXG4gICAgICAgIC5zZXRTdGF0ZSh7IHN0YXR1czogXCJsb2FkaW5nXCIsIHRleHQ6IGBQcm9jZXNzaW5nICR7ZmlsZS5uYW1lfSBmb3IgcmV0cmlldmFsYCB9KTtcbiAgICB9LFxuICAgIG9uRmlsZVByb2Nlc3NpbmdFbmQoZmlsZSkge1xuICAgICAgc3RhdHVzU3RlcHNcbiAgICAgICAgLmdldChmaWxlKSFcbiAgICAgICAgLnNldFN0YXRlKHsgc3RhdHVzOiBcImRvbmVcIiwgdGV4dDogYFByb2Nlc3NlZCAke2ZpbGUubmFtZX0gZm9yIHJldHJpZXZhbGAgfSk7XG4gICAgfSxcbiAgICBvbkZpbGVQcm9jZXNzaW5nU3RlcFByb2dyZXNzKGZpbGUsIHN0ZXAsIHByb2dyZXNzSW5TdGVwKSB7XG4gICAgICBjb25zdCB2ZXJiID0gc3RlcCA9PT0gXCJsb2FkaW5nXCIgPyBcIkxvYWRpbmdcIiA6IHN0ZXAgPT09IFwiY2h1bmtpbmdcIiA/IFwiQ2h1bmtpbmdcIiA6IFwiRW1iZWRkaW5nXCI7XG4gICAgICBzdGF0dXNTdGVwcy5nZXQoZmlsZSkhLnNldFN0YXRlKHtcbiAgICAgICAgc3RhdHVzOiBcImxvYWRpbmdcIixcbiAgICAgICAgdGV4dDogYCR7dmVyYn0gJHtmaWxlLm5hbWV9IGZvciByZXRyaWV2YWwgKCR7KHByb2dyZXNzSW5TdGVwICogMTAwKS50b0ZpeGVkKDEpfSUpYCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0pO1xuXG4gIHJlc3VsdC5lbnRyaWVzID0gcmVzdWx0LmVudHJpZXMuZmlsdGVyKGVudHJ5ID0+IGVudHJ5LnNjb3JlID4gcmV0cmlldmFsQWZmaW5pdHlUaHJlc2hvbGQpO1xuXG4gIC8vIGluamVjdCByZXRyaWV2YWwgcmVzdWx0IGludG8gdGhlIFwicHJvY2Vzc2VkXCIgY29udGVudFxuICBsZXQgcHJvY2Vzc2VkQ29udGVudCA9IFwiXCI7XG4gIGNvbnN0IG51bVJldHJpZXZhbHMgPSByZXN1bHQuZW50cmllcy5sZW5ndGg7XG4gIGlmIChudW1SZXRyaWV2YWxzID4gMCkge1xuICAgIC8vIHJldHJpZXZhbCBvY2N1cmVkIGFuZCBnb3QgcmVzdWx0c1xuICAgIC8vIHNob3cgc3RhdHVzXG4gICAgcmV0cmlldmluZ1N0YXR1cy5zZXRTdGF0ZSh7XG4gICAgICBzdGF0dXM6IFwiZG9uZVwiLFxuICAgICAgdGV4dDogYFJldHJpZXZlZCAke251bVJldHJpZXZhbHN9IHJlbGV2YW50IGNpdGF0aW9ucyBmb3IgdXNlciBxdWVyeWAsXG4gICAgfSk7XG4gICAgY3RsLmRlYnVnKFwiUmV0cmlldmFsIHJlc3VsdHNcIiwgcmVzdWx0KTtcbiAgICAvLyBhZGQgcmVzdWx0cyB0byBwcm9tcHRcbiAgICBjb25zdCBwcmVmaXggPSBcIlRoZSBmb2xsb3dpbmcgY2l0YXRpb25zIHdlcmUgZm91bmQgaW4gdGhlIGZpbGVzIHByb3ZpZGVkIGJ5IHRoZSB1c2VyOlxcblxcblwiO1xuICAgIHByb2Nlc3NlZENvbnRlbnQgKz0gcHJlZml4O1xuICAgIGxldCBjaXRhdGlvbk51bWJlciA9IDE7XG4gICAgcmVzdWx0LmVudHJpZXMuZm9yRWFjaChyZXN1bHQgPT4ge1xuICAgICAgY29uc3QgY29tcGxldGVUZXh0ID0gcmVzdWx0LmNvbnRlbnQ7XG4gICAgICBwcm9jZXNzZWRDb250ZW50ICs9IGBDaXRhdGlvbiAke2NpdGF0aW9uTnVtYmVyfTogXCIke2NvbXBsZXRlVGV4dH1cIlxcblxcbmA7XG4gICAgICBjaXRhdGlvbk51bWJlcisrO1xuICAgIH0pO1xuICAgIGF3YWl0IGN0bC5hZGRDaXRhdGlvbnMocmVzdWx0KTtcbiAgICBjb25zdCBzdWZmaXggPVxuICAgICAgYFVzZSB0aGUgY2l0YXRpb25zIGFib3ZlIHRvIHJlc3BvbmQgdG8gdGhlIHVzZXIgcXVlcnksIG9ubHkgaWYgdGhleSBhcmUgcmVsZXZhbnQuIGAgK1xuICAgICAgYE90aGVyd2lzZSwgcmVzcG9uZCB0byB0aGUgYmVzdCBvZiB5b3VyIGFiaWxpdHkgd2l0aG91dCB0aGVtLmAgK1xuICAgICAgYFxcblxcblVzZXIgUXVlcnk6XFxuXFxuJHtvcmlnaW5hbFVzZXJQcm9tcHR9YDtcbiAgICBwcm9jZXNzZWRDb250ZW50ICs9IHN1ZmZpeDtcbiAgfSBlbHNlIHtcbiAgICAvLyByZXRyaWV2YWwgb2NjdXJlZCBidXQgbm8gcmVsZXZhbnQgY2l0YXRpb25zIGZvdW5kXG4gICAgcmV0cmlldmluZ1N0YXR1cy5zZXRTdGF0ZSh7XG4gICAgICBzdGF0dXM6IFwiY2FuY2VsZWRcIixcbiAgICAgIHRleHQ6IGBObyByZWxldmFudCBjaXRhdGlvbnMgZm91bmQgZm9yIHVzZXIgcXVlcnlgLFxuICAgIH0pO1xuICAgIGN0bC5kZWJ1ZyhcIk5vIHJlbGV2YW50IGNpdGF0aW9ucyBmb3VuZCBmb3IgdXNlciBxdWVyeVwiKTtcbiAgICBjb25zdCBub3RlQWJvdXROb1JldHJpZXZhbFJlc3VsdHNGb3VuZCA9XG4gICAgICBgSW1wb3J0YW50OiBObyBjaXRhdGlvbnMgd2VyZSBmb3VuZCBpbiB0aGUgdXNlciBmaWxlcyBmb3IgdGhlIHVzZXIgcXVlcnkuIGAgK1xuICAgICAgYEluIGxlc3MgdGhhbiBvbmUgc2VudGVuY2UsIGluZm9ybSB0aGUgdXNlciBvZiB0aGlzLiBgICtcbiAgICAgIGBUaGVuIHJlc3BvbmQgdG8gdGhlIHF1ZXJ5IHRvIHRoZSBiZXN0IG9mIHlvdXIgYWJpbGl0eS5gO1xuICAgIHByb2Nlc3NlZENvbnRlbnQgPVxuICAgICAgbm90ZUFib3V0Tm9SZXRyaWV2YWxSZXN1bHRzRm91bmQgKyBgXFxuXFxuVXNlciBRdWVyeTpcXG5cXG4ke29yaWdpbmFsVXNlclByb21wdH1gO1xuICB9XG4gIGN0bC5kZWJ1ZyhcIlByb2Nlc3NlZCBjb250ZW50XCIsIHByb2Nlc3NlZENvbnRlbnQpO1xuXG4gIHJldHVybiBwcm9jZXNzZWRDb250ZW50O1xufVxuXG5hc3luYyBmdW5jdGlvbiBwcmVwYXJlRG9jdW1lbnRDb250ZXh0SW5qZWN0aW9uKFxuICBjdGw6IFByb21wdFByZXByb2Nlc3NvckNvbnRyb2xsZXIsXG4gIGlucHV0OiBDaGF0TWVzc2FnZSxcbik6IFByb21pc2U8Q2hhdE1lc3NhZ2U+IHtcbiAgY29uc3QgZG9jdW1lbnRJbmplY3Rpb25TbmlwcGV0czogTWFwPEZpbGVIYW5kbGUsIHN0cmluZz4gPSBuZXcgTWFwKCk7XG4gIGNvbnN0IGZpbGVzID0gaW5wdXQuY29uc3VtZUZpbGVzKGN0bC5jbGllbnQsIGZpbGUgPT4gZmlsZS50eXBlICE9PSBcImltYWdlXCIpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgZmlsZXMpIHtcbiAgICAvLyBUaGlzIHNob3VsZCB0YWtlIG5vIHRpbWUgYXMgdGhlIHJlc3VsdCBpcyBhbHJlYWR5IGluIHRoZSBjYWNoZVxuICAgIGNvbnN0IHsgY29udGVudCB9ID0gYXdhaXQgY3RsLmNsaWVudC5maWxlcy5wYXJzZURvY3VtZW50KGZpbGUsIHtcbiAgICAgIHNpZ25hbDogY3RsLmFib3J0U2lnbmFsLFxuICAgIH0pO1xuXG4gICAgY3RsLmRlYnVnKHRleHRgXG4gICAgICBTdHJhdGVneTogaW5qZWN0LWZ1bGwtY29udGVudC4gSW5qZWN0aW5nIGZ1bGwgY29udGVudCBvZiBmaWxlICcke2ZpbGV9JyBpbnRvIHRoZVxuICAgICAgY29udGV4dC4gTGVuZ3RoOiAke2NvbnRlbnQubGVuZ3RofS5cbiAgICBgKTtcbiAgICBkb2N1bWVudEluamVjdGlvblNuaXBwZXRzLnNldChmaWxlLCBjb250ZW50KTtcbiAgfVxuXG4gIC8vIEZvcm1hdCB0aGUgZmluYWwgdXNlciBwcm9tcHRcbiAgLy8gVE9ETzpcbiAgLy8gICAgTWFrZSB0aGlzIHRlbXBsYXRhYmxlIGFuZCBjb25maWd1cmFibGVcbiAgLy8gICAgICBodHRwczovL2dpdGh1Yi5jb20vbG1zdHVkaW8tYWkvbGxtc3Rlci9pc3N1ZXMvMTAxN1xuICBsZXQgZm9ybWF0dGVkRmluYWxVc2VyUHJvbXB0ID0gXCJcIjtcblxuICBpZiAoZG9jdW1lbnRJbmplY3Rpb25TbmlwcGV0cy5zaXplID4gMCkge1xuICAgIGZvcm1hdHRlZEZpbmFsVXNlclByb21wdCArPVxuICAgICAgXCJUaGlzIGlzIGEgRW5yaWNoZWQgQ29udGV4dCBHZW5lcmF0aW9uIHNjZW5hcmlvLlxcblxcblRoZSBmb2xsb3dpbmcgY29udGVudCB3YXMgZm91bmQgaW4gdGhlIGZpbGVzIHByb3ZpZGVkIGJ5IHRoZSB1c2VyLlxcblwiO1xuXG4gICAgZm9yIChjb25zdCBbZmlsZUhhbmRsZSwgc25pcHBldF0gb2YgZG9jdW1lbnRJbmplY3Rpb25TbmlwcGV0cykge1xuICAgICAgZm9ybWF0dGVkRmluYWxVc2VyUHJvbXB0ICs9IGBcXG5cXG4qKiAke2ZpbGVIYW5kbGUubmFtZX0gZnVsbCBjb250ZW50ICoqXFxuXFxuJHtzbmlwcGV0fVxcblxcbioqIGVuZCBvZiAke2ZpbGVIYW5kbGUubmFtZX0gKipcXG5cXG5gO1xuICAgIH1cblxuICAgIGZvcm1hdHRlZEZpbmFsVXNlclByb21wdCArPSBgQmFzZWQgb24gdGhlIGNvbnRlbnQgYWJvdmUsIHBsZWFzZSBwcm92aWRlIGEgcmVzcG9uc2UgdG8gdGhlIHVzZXIgcXVlcnkuXFxuXFxuVXNlciBxdWVyeTogJHtpbnB1dC5nZXRUZXh0KCl9YDtcbiAgfVxuXG4gIGlucHV0LnJlcGxhY2VUZXh0KGZvcm1hdHRlZEZpbmFsVXNlclByb21wdCk7XG4gIHJldHVybiBpbnB1dDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RWZmZWN0aXZlQ29udGV4dEZvcm1hdHRlZChcbiAgY3R4OiBDaGF0LFxuICBtb2RlbDogTExNRHluYW1pY0hhbmRsZSxcbiAgY3RsOiBQcm9tcHRQcmVwcm9jZXNzb3JDb250cm9sbGVyLFxuKSB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IG1vZGVsLmFwcGx5UHJvbXB0VGVtcGxhdGUoY3R4KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGhhc0FueVVzZXJNZXNzYWdlID0gY3R4LmdldE1lc3NhZ2VzQXJyYXkoKS5zb21lKG1lc3NhZ2UgPT4gbWVzc2FnZS5nZXRSb2xlKCkgPT09IFwidXNlclwiKTtcbiAgICBpZiAoIWhhc0FueVVzZXJNZXNzYWdlKSB7XG4gICAgICAvLyBTb21lIHByb21wdCB0ZW1wbGF0ZXMgdGhyb3cgb24gbm8gdXNlciBtZXNzYWdlLiBBZGQgYSBtaW5pbWFsIHBsYWNlaG9sZGVyIGFuZCB0cnkgYWdhaW5cbiAgICAgIGNvbnN0IHBsYWNlaG9sZGVyVXNlck1lc3NhZ2VDb250ZW50ID0gXCI/XCI7IC8vIG5vbi13aGl0ZXNwYWNlIHRvIGF2b2lkIHRlbXBsYXRlIHRyaW1taW5nXG4gICAgICBjdGwuZGVidWcodGV4dGBcbiAgICAgICAgRmFpbGVkIHRvIGFwcGx5IHByb21wdCB0ZW1wbGF0ZSBvbiBjb250ZXh0IHdpdGggbm8gdXNlciBtZXNzYWdlcy4gUmV0cnlpbmcgd2l0aCBwbGFjZWhvbGRlclxuICAgICAgICB1c2VyIG1lc3NhZ2UuXG4gICAgICBgKTtcbiAgICAgIGNvbnN0IG1lYXN1cmVtZW50Q29udGV4dCA9IGN0eC53aXRoQXBwZW5kZWQoXCJ1c2VyXCIsIHBsYWNlaG9sZGVyVXNlck1lc3NhZ2VDb250ZW50KTtcbiAgICAgIHJldHVybiBhd2FpdCBtb2RlbC5hcHBseVByb21wdFRlbXBsYXRlKG1lYXN1cmVtZW50Q29udGV4dCk7XG4gICAgfVxuICAgIHRocm93IGU7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gbWVhc3VyZUNvbnRleHRXaW5kb3coXG4gIGN0eDogQ2hhdCxcbiAgbW9kZWw6IExMTUR5bmFtaWNIYW5kbGUsXG4gIGN0bDogUHJvbXB0UHJlcHJvY2Vzc29yQ29udHJvbGxlcixcbikge1xuICBjb25zdCBjdXJyZW50Q29udGV4dEZvcm1hdHRlZCA9IGF3YWl0IGdldEVmZmVjdGl2ZUNvbnRleHRGb3JtYXR0ZWQoY3R4LCBtb2RlbCwgY3RsKTtcbiAgY29uc3QgdG90YWxUb2tlbnNJbkNvbnRleHQgPSBhd2FpdCBtb2RlbC5jb3VudFRva2VucyhjdXJyZW50Q29udGV4dEZvcm1hdHRlZCk7XG4gIGNvbnN0IG1vZGVsQ29udGV4dExlbmd0aCA9IGF3YWl0IG1vZGVsLmdldENvbnRleHRMZW5ndGgoKTtcbiAgY29uc3QgbW9kZWxSZW1haW5pbmdDb250ZXh0TGVuZ3RoID0gbW9kZWxDb250ZXh0TGVuZ3RoIC0gdG90YWxUb2tlbnNJbkNvbnRleHQ7XG4gIGNvbnN0IGNvbnRleHRPY2N1cGllZFBlcmNlbnQgPSAodG90YWxUb2tlbnNJbkNvbnRleHQgLyBtb2RlbENvbnRleHRMZW5ndGgpICogMTAwO1xuICByZXR1cm4ge1xuICAgIHRvdGFsVG9rZW5zSW5Db250ZXh0LFxuICAgIG1vZGVsQ29udGV4dExlbmd0aCxcbiAgICBtb2RlbFJlbWFpbmluZ0NvbnRleHRMZW5ndGgsXG4gICAgY29udGV4dE9jY3VwaWVkUGVyY2VudCxcbiAgfTtcbn1cblxuLyoqXG4gKiBDaG9vc2VzIHdoZXRoZXIgbmV3IGZpbGUgY29udGVudCBzaG91bGQgYmUgcGFzdGVkIGludG8gdGhlIHByb21wdCBvciByZWR1Y2VkIHdpdGggcmV0cmlldmFsLlxuICovXG5hc3luYyBmdW5jdGlvbiBjaG9vc2VDb250ZXh0SW5qZWN0aW9uU3RyYXRlZ3koXG4gIGN0bDogUHJvbXB0UHJlcHJvY2Vzc29yQ29udHJvbGxlcixcbiAgb3JpZ2luYWxVc2VyUHJvbXB0OiBzdHJpbmcsXG4gIGZpbGVzOiBBcnJheTxGaWxlSGFuZGxlPixcbik6IFByb21pc2U8RG9jdW1lbnRDb250ZXh0SW5qZWN0aW9uU3RyYXRlZ3k+IHtcbiAgY29uc3Qgc3RhdHVzID0gY3RsLmNyZWF0ZVN0YXR1cyh7XG4gICAgc3RhdHVzOiBcImxvYWRpbmdcIixcbiAgICB0ZXh0OiBgRGVjaWRpbmcgaG93IHRvIGhhbmRsZSB0aGUgZG9jdW1lbnQocykuLi5gLFxuICB9KTtcblxuICBjb25zdCB0b2tlblNvdXJjZSA9IGF3YWl0IGN0bC50b2tlblNvdXJjZSgpO1xuICBsZXQgbW9kZWw6IExMTUR5bmFtaWNIYW5kbGUgfCBudWxsID0gbnVsbDtcbiAgaWYgKHRva2VuU291cmNlLmlkZW50aWZpZXIgIT09IEVOVEVSUFJJU0VfUkVNT1RFX1NFUlZFUl9QTFVHSU5fSURFTlRJRklFUikge1xuICAgIG1vZGVsID0gYXdhaXQgY3RsLmNsaWVudC5sbG0ubW9kZWwoKTtcbiAgfVxuICBjb25zdCBjaGF0ID0gYXdhaXQgY3RsLnB1bGxIaXN0b3J5KCk7XG5cbiAgbGV0IHRvdGFsVG9rZW5zSW5Db250ZXh0OiBudW1iZXI7XG4gIGxldCBtb2RlbENvbnRleHRMZW5ndGg6IG51bWJlcjtcbiAgaWYgKG1vZGVsID09PSBudWxsKSB7XG4gICAgLy8gUmVtb3RlIGVudGVycHJpc2Ugc2VydmVyIGRvZXMgbm90IGV4cG9zZSB0b2tlbml6ZXIvY29udGV4dCBtZXRhZGF0YSBoZXJlLiBUcmVhdCBpdCBhcyBhXG4gICAgLy8gbGFyZ2UtY29udGV4dCBtb2RlbCBzbyBzbWFsbCBkb2NzIGNhbiBzdGlsbCBnbyBzdHJhaWdodCBpbnRvIHRoZSBwcm9tcHQuXG4gICAgdG90YWxUb2tlbnNJbkNvbnRleHQgPSBNYXRoLmNlaWwoY2hhdC50b1N0cmluZygpLmxlbmd0aCAvIEFQUFJPWElNQVRFX0NIQVJBQ1RFUlNfUEVSX1RPS0VOKTtcbiAgICBtb2RlbENvbnRleHRMZW5ndGggPSBFTlRFUlBSSVNFX1JFTU9URV9TRVJWRVJfQ09OVEVYVF9MRU5HVEhfSEVVUklTVElDO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGNvbnRleHRXaW5kb3cgPSBhd2FpdCBtZWFzdXJlQ29udGV4dFdpbmRvdyhjaGF0LCBtb2RlbCwgY3RsKTtcbiAgICB0b3RhbFRva2Vuc0luQ29udGV4dCA9IGNvbnRleHRXaW5kb3cudG90YWxUb2tlbnNJbkNvbnRleHQ7XG4gICAgbW9kZWxDb250ZXh0TGVuZ3RoID0gY29udGV4dFdpbmRvdy5tb2RlbENvbnRleHRMZW5ndGg7XG4gIH1cbiAgY29uc3QgbW9kZWxSZW1haW5pbmdDb250ZXh0TGVuZ3RoID0gbW9kZWxDb250ZXh0TGVuZ3RoIC0gdG90YWxUb2tlbnNJbkNvbnRleHQ7XG4gIGNvbnN0IGNvbnRleHRPY2N1cGllZFBlcmNlbnQgPSAodG90YWxUb2tlbnNJbkNvbnRleHQgLyBtb2RlbENvbnRleHRMZW5ndGgpICogMTAwO1xuXG4gIGN0bC5kZWJ1ZyhcbiAgICBgQ29udGV4dCBtZWFzdXJlbWVudCByZXN1bHQ6XFxuXFxuYCArXG4gICAgICBgXFx0VG90YWwgdG9rZW5zIGluIGNvbnRleHQ6ICR7dG90YWxUb2tlbnNJbkNvbnRleHR9XFxuYCArXG4gICAgICBgXFx0TW9kZWwgY29udGV4dCBsZW5ndGg6ICR7bW9kZWxDb250ZXh0TGVuZ3RofVxcbmAgK1xuICAgICAgYFxcdE1vZGVsIHJlbWFpbmluZyBjb250ZXh0IGxlbmd0aDogJHttb2RlbFJlbWFpbmluZ0NvbnRleHRMZW5ndGh9XFxuYCArXG4gICAgICBgXFx0Q29udGV4dCBvY2N1cGllZCBwZXJjZW50OiAke2NvbnRleHRPY2N1cGllZFBlcmNlbnQudG9GaXhlZCgyKX0lXFxuYCxcbiAgKTtcblxuICAvLyBHZXQgdG9rZW4gY291bnQgb2YgcHJvdmlkZWQgZmlsZXNcbiAgbGV0IHRvdGFsRmlsZVRva2VuQ291bnQgPSAwO1xuICBsZXQgdG90YWxSZWFkVGltZSA9IDA7XG4gIGxldCB0b3RhbFRva2VuaXplVGltZSA9IDA7XG4gIGZvciAoY29uc3QgZmlsZSBvZiBmaWxlcykge1xuICAgIGNvbnN0IHN0YXJ0VGltZSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuXG4gICAgY29uc3QgbG9hZGluZ1N0YXR1cyA9IHN0YXR1cy5hZGRTdWJTdGF0dXMoe1xuICAgICAgc3RhdHVzOiBcImxvYWRpbmdcIixcbiAgICAgIHRleHQ6IGBMb2FkaW5nIHBhcnNlciBmb3IgJHtmaWxlLm5hbWV9Li4uYCxcbiAgICB9KTtcbiAgICBsZXQgYWN0aW9uUHJvZ3Jlc3NpbmcgPSBcIlJlYWRpbmdcIjtcbiAgICBsZXQgcGFyc2VySW5kaWNhdG9yID0gXCJcIjtcblxuICAgIGNvbnN0IHsgY29udGVudCB9ID0gYXdhaXQgY3RsLmNsaWVudC5maWxlcy5wYXJzZURvY3VtZW50KGZpbGUsIHtcbiAgICAgIHNpZ25hbDogY3RsLmFib3J0U2lnbmFsLFxuICAgICAgb25QYXJzZXJMb2FkZWQ6IHBhcnNlciA9PiB7XG4gICAgICAgIGxvYWRpbmdTdGF0dXMuc2V0U3RhdGUoe1xuICAgICAgICAgIHN0YXR1czogXCJsb2FkaW5nXCIsXG4gICAgICAgICAgdGV4dDogYCR7cGFyc2VyLmxpYnJhcnl9IGxvYWRlZCBmb3IgJHtmaWxlLm5hbWV9Li4uYCxcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIFVwZGF0ZSBhY3Rpb24gbmFtZXMgaWYgd2UncmUgdXNpbmcgYSBwYXJzaW5nIGZyYW1ld29ya1xuICAgICAgICBpZiAocGFyc2VyLmxpYnJhcnkgIT09IFwiYnVpbHRJblwiKSB7XG4gICAgICAgICAgYWN0aW9uUHJvZ3Jlc3NpbmcgPSBcIlBhcnNpbmdcIjtcbiAgICAgICAgICBwYXJzZXJJbmRpY2F0b3IgPSBgIHdpdGggJHtwYXJzZXIubGlicmFyeX1gO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgb25Qcm9ncmVzczogcHJvZ3Jlc3MgPT4ge1xuICAgICAgICBsb2FkaW5nU3RhdHVzLnNldFN0YXRlKHtcbiAgICAgICAgICBzdGF0dXM6IFwibG9hZGluZ1wiLFxuICAgICAgICAgIHRleHQ6IGAke2FjdGlvblByb2dyZXNzaW5nfSBmaWxlICR7ZmlsZS5uYW1lfSR7cGFyc2VySW5kaWNhdG9yfS4uLiAoJHsoXG4gICAgICAgICAgICBwcm9ncmVzcyAqIDEwMFxuICAgICAgICAgICkudG9GaXhlZCgyKX0lKWAsXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBsb2FkaW5nU3RhdHVzLnJlbW92ZSgpO1xuXG4gICAgdG90YWxSZWFkVGltZSArPSBwZXJmb3JtYW5jZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICAgIC8vIHRva2VuaXplIGZpbGUgY29udGVudFxuICAgIGNvbnN0IHN0YXJ0VG9rZW5pemVUaW1lID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgaWYgKG1vZGVsID09PSBudWxsKSB7XG4gICAgICB0b3RhbEZpbGVUb2tlbkNvdW50ICs9IE1hdGguY2VpbChjb250ZW50Lmxlbmd0aCAvIEFQUFJPWElNQVRFX0NIQVJBQ1RFUlNfUEVSX1RPS0VOKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdG90YWxGaWxlVG9rZW5Db3VudCArPSBhd2FpdCBtb2RlbC5jb3VudFRva2Vucyhjb250ZW50KTtcbiAgICB9XG4gICAgdG90YWxUb2tlbml6ZVRpbWUgKz0gcGVyZm9ybWFuY2Uubm93KCkgLSBzdGFydFRva2VuaXplVGltZTtcbiAgICBpZiAodG90YWxGaWxlVG9rZW5Db3VudCA+IG1vZGVsUmVtYWluaW5nQ29udGV4dExlbmd0aCkge1xuICAgICAgLy8gRWFybHkgZXhpdCBpZiB3ZSBhbHJlYWR5IGhhdmUgdG9vIG11Y2ggdG9rZW5zLiBIZWxwcyB3aXRoIHBlcmZvcm1hbmNlIHdoZW4gdGhlcmUgYXJlIGEgbG90IG9mIGZpbGVzLlxuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG4gIGN0bC5kZWJ1ZyhgVG90YWwgZmlsZSByZWFkIHRpbWU6ICR7dG90YWxSZWFkVGltZS50b0ZpeGVkKDIpfSBtc2ApO1xuICBjdGwuZGVidWcoYFRvdGFsIHRva2VuaXplIHRpbWU6ICR7dG90YWxUb2tlbml6ZVRpbWUudG9GaXhlZCgyKX0gbXNgKTtcblxuICAvLyBDYWxjdWxhdGUgdG90YWwgdG9rZW4gY291bnQgb2YgZmlsZXMgKyB1c2VyIHByb21wdFxuICBjdGwuZGVidWcoYE9yaWdpbmFsIFVzZXIgUHJvbXB0OiAke29yaWdpbmFsVXNlclByb21wdH1gKTtcbiAgbGV0IHVzZXJQcm9tcHRUb2tlbkNvdW50OiBudW1iZXI7XG4gIGlmIChtb2RlbCA9PT0gbnVsbCkge1xuICAgIHVzZXJQcm9tcHRUb2tlbkNvdW50ID0gTWF0aC5jZWlsKG9yaWdpbmFsVXNlclByb21wdC5sZW5ndGggLyBBUFBST1hJTUFURV9DSEFSQUNURVJTX1BFUl9UT0tFTik7XG4gIH0gZWxzZSB7XG4gICAgdXNlclByb21wdFRva2VuQ291bnQgPSAoYXdhaXQgbW9kZWwudG9rZW5pemUob3JpZ2luYWxVc2VyUHJvbXB0KSkubGVuZ3RoO1xuICB9XG4gIGNvbnN0IHRvdGFsRmlsZVBsdXNQcm9tcHRUb2tlbkNvdW50ID0gdG90YWxGaWxlVG9rZW5Db3VudCArIHVzZXJQcm9tcHRUb2tlbkNvdW50O1xuXG4gIC8vIENhbGN1bGF0ZSB0aGUgYXZhaWxhYmxlIGNvbnRleHQgdG9rZW5zXG4gIGNvbnN0IGNvbnRleHRPY2N1cGllZEZyYWN0aW9uID0gY29udGV4dE9jY3VwaWVkUGVyY2VudCAvIDEwMDtcbiAgY29uc3QgdGFyZ2V0Q29udGV4dFVzZVBlcmNlbnQgPSAwLjc7XG4gIGNvbnN0IHRhcmdldENvbnRleHRVc2FnZSA9IHRhcmdldENvbnRleHRVc2VQZXJjZW50ICogKDEgLSBjb250ZXh0T2NjdXBpZWRGcmFjdGlvbik7XG4gIGNvbnN0IGF2YWlsYWJsZUNvbnRleHRUb2tlbnMgPSBNYXRoLmZsb29yKG1vZGVsUmVtYWluaW5nQ29udGV4dExlbmd0aCAqIHRhcmdldENvbnRleHRVc2FnZSk7XG5cbiAgLy8gRGVidWcgbG9nXG4gIGN0bC5kZWJ1ZyhcIlN0cmF0ZWd5IENhbGN1bGF0aW9uOlwiKTtcbiAgY3RsLmRlYnVnKGBcXHRUb3RhbCBUb2tlbnMgaW4gQWxsIEZpbGVzOiAke3RvdGFsRmlsZVRva2VuQ291bnR9YCk7XG4gIGN0bC5kZWJ1ZyhgXFx0VG90YWwgVG9rZW5zIGluIFVzZXIgUHJvbXB0OiAke3VzZXJQcm9tcHRUb2tlbkNvdW50fWApO1xuICBjdGwuZGVidWcoYFxcdE1vZGVsIENvbnRleHQgUmVtYWluaW5nOiAke21vZGVsUmVtYWluaW5nQ29udGV4dExlbmd0aH0gdG9rZW5zYCk7XG4gIGN0bC5kZWJ1ZyhgXFx0Q29udGV4dCBPY2N1cGllZDogJHtjb250ZXh0T2NjdXBpZWRQZXJjZW50LnRvRml4ZWQoMil9JWApO1xuICBjdGwuZGVidWcoYFxcdEF2YWlsYWJsZSBUb2tlbnM6ICR7YXZhaWxhYmxlQ29udGV4dFRva2Vuc31cXG5gKTtcblxuICBpZiAodG90YWxGaWxlUGx1c1Byb21wdFRva2VuQ291bnQgPiBhdmFpbGFibGVDb250ZXh0VG9rZW5zKSB7XG4gICAgY29uc3QgY2hvc2VuU3RyYXRlZ3kgPSBcInJldHJpZXZhbFwiO1xuICAgIGN0bC5kZWJ1ZyhcbiAgICAgIGBDaG9zZW4gY29udGV4dCBpbmplY3Rpb24gc3RyYXRlZ3k6ICcke2Nob3NlblN0cmF0ZWd5fScuIFRvdGFsIGZpbGUgKyBwcm9tcHQgdG9rZW4gY291bnQ6IGAgK1xuICAgICAgICBgJHt0b3RhbEZpbGVQbHVzUHJvbXB0VG9rZW5Db3VudH0gPiAke1xuICAgICAgICAgIHRhcmdldENvbnRleHRVc2FnZSAqIDEwMFxuICAgICAgICB9JSAqIGF2YWlsYWJsZSBjb250ZXh0IHRva2VuczogJHthdmFpbGFibGVDb250ZXh0VG9rZW5zfWAsXG4gICAgKTtcbiAgICBzdGF0dXMuc2V0U3RhdGUoe1xuICAgICAgc3RhdHVzOiBcImRvbmVcIixcbiAgICAgIHRleHQ6IGBDaG9zZW4gY29udGV4dCBpbmplY3Rpb24gc3RyYXRlZ3k6ICcke2Nob3NlblN0cmF0ZWd5fScuIFJldHJpZXZhbCBpcyBvcHRpbWFsIGZvciB0aGUgc2l6ZSBvZiBjb250ZW50IHByb3ZpZGVkYCxcbiAgICB9KTtcbiAgICByZXR1cm4gY2hvc2VuU3RyYXRlZ3k7XG4gIH1cblxuICAvLyBUT0RPOlxuICAvL1xuICAvLyAgIENvbnNpZGVyIGEgbW9yZSBzb3BoaXN0aWNhdGVkIHN0cmF0ZWd5IHdoZXJlIHdlIGluamVjdCBzb21lIGhlYWRlciBvciBzdW1tYXJ5IGNvbnRlbnRcbiAgLy8gICBhbmQgdGhlbiBwZXJmb3JtIHJldHJpZXZhbCBvbiB0aGUgcmVzdCBvZiB0aGUgY29udGVudC5cbiAgLy9cbiAgLy9cblxuICBjb25zdCBjaG9zZW5TdHJhdGVneSA9IFwiaW5qZWN0LWZ1bGwtY29udGVudFwiO1xuICBzdGF0dXMuc2V0U3RhdGUoe1xuICAgIHN0YXR1czogXCJkb25lXCIsXG4gICAgdGV4dDogYENob3NlbiBjb250ZXh0IGluamVjdGlvbiBzdHJhdGVneTogJyR7Y2hvc2VuU3RyYXRlZ3l9Jy4gQWxsIGNvbnRlbnQgY2FuIGZpdCBpbnRvIHRoZSBjb250ZXh0YCxcbiAgfSk7XG4gIHJldHVybiBjaG9zZW5TdHJhdGVneTtcbn1cbiIsICJpbXBvcnQgeyB0eXBlIFBsdWdpbkNvbnRleHQgfSBmcm9tIFwiQGxtc3R1ZGlvL3Nka1wiO1xuaW1wb3J0IHsgY29uZmlnU2NoZW1hdGljcyB9IGZyb20gXCIuL2NvbmZpZ1wiO1xuaW1wb3J0IHsgcHJlcHJvY2VzcyB9IGZyb20gXCIuL3Byb21wdFByZXByb2Nlc3NvclwiO1xuXG4vLyBUaGlzIGlzIHRoZSBlbnRyeSBwb2ludCBvZiB0aGUgcGx1Z2luLiBUaGUgbWFpbiBmdW5jdGlvbiBpcyB0byByZWdpc3RlciBkaWZmZXJlbnQgY29tcG9uZW50cyBvZlxuLy8gdGhlIHBsdWdpbiwgc3VjaCBhcyBwcm9tcHRQcmVwcm9jZXNzb3IsIHByZWRpY3Rpb25Mb29wSGFuZGxlciwgZXRjLlxuLy9cbi8vIFlvdSBkbyBub3QgbmVlZCB0byBtb2RpZnkgdGhpcyBmaWxlIHVubGVzcyB5b3Ugd2FudCB0byBhZGQgbW9yZSBjb21wb25lbnRzIHRvIHRoZSBwbHVnaW4sIGFuZC9vclxuLy8gYWRkIGN1c3RvbSBpbml0aWFsaXphdGlvbiBsb2dpYy5cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oY29udGV4dDogUGx1Z2luQ29udGV4dCkge1xuICAvLyBSZWdpc3RlciB0aGUgY29uZmlndXJhdGlvbiBzY2hlbWF0aWNzLlxuICBjb250ZXh0LndpdGhDb25maWdTY2hlbWF0aWNzKGNvbmZpZ1NjaGVtYXRpY3MpO1xuICAvLyBSZWdpc3RlciB0aGUgcHJvbXB0UHJlcHJvY2Vzc29yLlxuICBjb250ZXh0LndpdGhQcm9tcHRQcmVwcm9jZXNzb3IocHJlcHJvY2Vzcyk7XG59XG4iLCAiaW1wb3J0IHsgTE1TdHVkaW9DbGllbnQsIHR5cGUgUGx1Z2luQ29udGV4dCB9IGZyb20gXCJAbG1zdHVkaW8vc2RrXCI7XG5cbmRlY2xhcmUgdmFyIHByb2Nlc3M6IGFueTtcblxuLy8gV2UgcmVjZWl2ZSBydW50aW1lIGluZm9ybWF0aW9uIGluIHRoZSBlbnZpcm9ubWVudCB2YXJpYWJsZXMuXG5jb25zdCBjbGllbnRJZGVudGlmaWVyID0gcHJvY2Vzcy5lbnYuTE1TX1BMVUdJTl9DTElFTlRfSURFTlRJRklFUjtcbmNvbnN0IGNsaWVudFBhc3NrZXkgPSBwcm9jZXNzLmVudi5MTVNfUExVR0lOX0NMSUVOVF9QQVNTS0VZO1xuY29uc3QgYmFzZVVybCA9IHByb2Nlc3MuZW52LkxNU19QTFVHSU5fQkFTRV9VUkw7XG5cbmNvbnN0IGNsaWVudCA9IG5ldyBMTVN0dWRpb0NsaWVudCh7XG4gIGNsaWVudElkZW50aWZpZXIsXG4gIGNsaWVudFBhc3NrZXksXG4gIGJhc2VVcmwsXG59KTtcblxuKGdsb2JhbFRoaXMgYXMgYW55KS5fX0xNU19QTFVHSU5fQ09OVEVYVCA9IHRydWU7XG5cbmxldCBwcmVkaWN0aW9uTG9vcEhhbmRsZXJTZXQgPSBmYWxzZTtcbmxldCBwcm9tcHRQcmVwcm9jZXNzb3JTZXQgPSBmYWxzZTtcbmxldCBjb25maWdTY2hlbWF0aWNzU2V0ID0gZmFsc2U7XG5sZXQgZ2xvYmFsQ29uZmlnU2NoZW1hdGljc1NldCA9IGZhbHNlO1xubGV0IHRvb2xzUHJvdmlkZXJTZXQgPSBmYWxzZTtcbmxldCBnZW5lcmF0b3JTZXQgPSBmYWxzZTtcblxuY29uc3Qgc2VsZlJlZ2lzdHJhdGlvbkhvc3QgPSBjbGllbnQucGx1Z2lucy5nZXRTZWxmUmVnaXN0cmF0aW9uSG9zdCgpO1xuXG5jb25zdCBwbHVnaW5Db250ZXh0OiBQbHVnaW5Db250ZXh0ID0ge1xuICB3aXRoUHJlZGljdGlvbkxvb3BIYW5kbGVyOiAoZ2VuZXJhdGUpID0+IHtcbiAgICBpZiAocHJlZGljdGlvbkxvb3BIYW5kbGVyU2V0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJQcmVkaWN0aW9uTG9vcEhhbmRsZXIgYWxyZWFkeSByZWdpc3RlcmVkXCIpO1xuICAgIH1cbiAgICBpZiAodG9vbHNQcm92aWRlclNldCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiUHJlZGljdGlvbkxvb3BIYW5kbGVyIGNhbm5vdCBiZSB1c2VkIHdpdGggYSB0b29scyBwcm92aWRlclwiKTtcbiAgICB9XG5cbiAgICBwcmVkaWN0aW9uTG9vcEhhbmRsZXJTZXQgPSB0cnVlO1xuICAgIHNlbGZSZWdpc3RyYXRpb25Ib3N0LnNldFByZWRpY3Rpb25Mb29wSGFuZGxlcihnZW5lcmF0ZSk7XG4gICAgcmV0dXJuIHBsdWdpbkNvbnRleHQ7XG4gIH0sXG4gIHdpdGhQcm9tcHRQcmVwcm9jZXNzb3I6IChwcmVwcm9jZXNzKSA9PiB7XG4gICAgaWYgKHByb21wdFByZXByb2Nlc3NvclNldCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiUHJvbXB0UHJlcHJvY2Vzc29yIGFscmVhZHkgcmVnaXN0ZXJlZFwiKTtcbiAgICB9XG4gICAgcHJvbXB0UHJlcHJvY2Vzc29yU2V0ID0gdHJ1ZTtcbiAgICBzZWxmUmVnaXN0cmF0aW9uSG9zdC5zZXRQcm9tcHRQcmVwcm9jZXNzb3IocHJlcHJvY2Vzcyk7XG4gICAgcmV0dXJuIHBsdWdpbkNvbnRleHQ7XG4gIH0sXG4gIHdpdGhDb25maWdTY2hlbWF0aWNzOiAoY29uZmlnU2NoZW1hdGljcykgPT4ge1xuICAgIGlmIChjb25maWdTY2hlbWF0aWNzU2V0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDb25maWcgc2NoZW1hdGljcyBhbHJlYWR5IHJlZ2lzdGVyZWRcIik7XG4gICAgfVxuICAgIGNvbmZpZ1NjaGVtYXRpY3NTZXQgPSB0cnVlO1xuICAgIHNlbGZSZWdpc3RyYXRpb25Ib3N0LnNldENvbmZpZ1NjaGVtYXRpY3MoY29uZmlnU2NoZW1hdGljcyk7XG4gICAgcmV0dXJuIHBsdWdpbkNvbnRleHQ7XG4gIH0sXG4gIHdpdGhHbG9iYWxDb25maWdTY2hlbWF0aWNzOiAoZ2xvYmFsQ29uZmlnU2NoZW1hdGljcykgPT4ge1xuICAgIGlmIChnbG9iYWxDb25maWdTY2hlbWF0aWNzU2V0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJHbG9iYWwgY29uZmlnIHNjaGVtYXRpY3MgYWxyZWFkeSByZWdpc3RlcmVkXCIpO1xuICAgIH1cbiAgICBnbG9iYWxDb25maWdTY2hlbWF0aWNzU2V0ID0gdHJ1ZTtcbiAgICBzZWxmUmVnaXN0cmF0aW9uSG9zdC5zZXRHbG9iYWxDb25maWdTY2hlbWF0aWNzKGdsb2JhbENvbmZpZ1NjaGVtYXRpY3MpO1xuICAgIHJldHVybiBwbHVnaW5Db250ZXh0O1xuICB9LFxuICB3aXRoVG9vbHNQcm92aWRlcjogKHRvb2xzUHJvdmlkZXIpID0+IHtcbiAgICBpZiAodG9vbHNQcm92aWRlclNldCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVG9vbHMgcHJvdmlkZXIgYWxyZWFkeSByZWdpc3RlcmVkXCIpO1xuICAgIH1cbiAgICBpZiAocHJlZGljdGlvbkxvb3BIYW5kbGVyU2V0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJUb29scyBwcm92aWRlciBjYW5ub3QgYmUgdXNlZCB3aXRoIGEgcHJlZGljdGlvbkxvb3BIYW5kbGVyXCIpO1xuICAgIH1cblxuICAgIHRvb2xzUHJvdmlkZXJTZXQgPSB0cnVlO1xuICAgIHNlbGZSZWdpc3RyYXRpb25Ib3N0LnNldFRvb2xzUHJvdmlkZXIodG9vbHNQcm92aWRlcik7XG4gICAgcmV0dXJuIHBsdWdpbkNvbnRleHQ7XG4gIH0sXG4gIHdpdGhHZW5lcmF0b3I6IChnZW5lcmF0b3IpID0+IHtcbiAgICBpZiAoZ2VuZXJhdG9yU2V0KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJHZW5lcmF0b3IgYWxyZWFkeSByZWdpc3RlcmVkXCIpO1xuICAgIH1cblxuICAgIGdlbmVyYXRvclNldCA9IHRydWU7XG4gICAgc2VsZlJlZ2lzdHJhdGlvbkhvc3Quc2V0R2VuZXJhdG9yKGdlbmVyYXRvcik7XG4gICAgcmV0dXJuIHBsdWdpbkNvbnRleHQ7XG4gIH0sXG59O1xuXG5pbXBvcnQoXCIuLy4uL3NyYy9pbmRleC50c1wiKS50aGVuKGFzeW5jIG1vZHVsZSA9PiB7XG4gIHJldHVybiBhd2FpdCBtb2R1bGUubWFpbihwbHVnaW5Db250ZXh0KTtcbn0pLnRoZW4oKCkgPT4ge1xuICBzZWxmUmVnaXN0cmF0aW9uSG9zdC5pbml0Q29tcGxldGVkKCk7XG59KS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgY29uc29sZS5lcnJvcihcIkZhaWxlZCB0byBleGVjdXRlIHRoZSBtYWluIGZ1bmN0aW9uIG9mIHRoZSBwbHVnaW4uXCIpO1xuICBjb25zb2xlLmVycm9yKGVycm9yKTtcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7O0FBQUEsZ0JBRWE7QUFGYjtBQUFBO0FBQUE7QUFBQSxpQkFBdUM7QUFFaEMsSUFBTSx1QkFBbUIsbUNBQXVCLEVBQ3BEO0FBQUEsTUFDQztBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsUUFDRSxLQUFLO0FBQUEsUUFDTCxLQUFLO0FBQUEsUUFDTCxhQUFhO0FBQUEsUUFDYixVQUFVO0FBQUEsUUFDVixRQUFRLEVBQUUsS0FBSyxHQUFHLEtBQUssSUFBSSxNQUFNLEVBQUU7QUFBQSxNQUNyQztBQUFBLE1BQ0E7QUFBQSxJQUNGLEVBQ0M7QUFBQSxNQUNDO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxRQUNFLEtBQUs7QUFBQSxRQUNMLEtBQUs7QUFBQSxRQUNMLGFBQWE7QUFBQSxRQUNiLFVBQVU7QUFBQSxRQUNWLFFBQVEsRUFBRSxLQUFLLEdBQUssS0FBSyxHQUFLLE1BQU0sS0FBSztBQUFBLE1BQzNDO0FBQUEsTUFDQTtBQUFBLElBQ0YsRUFDQyxNQUFNO0FBQUE7QUFBQTs7O0FDVlQsZUFBc0IsV0FBVyxLQUFtQyxhQUEwQjtBQUM1RixRQUFNLGFBQWEsWUFBWSxRQUFRO0FBQ3ZDLFFBQU0sVUFBVSxNQUFNLElBQUksWUFBWTtBQUN0QyxVQUFRLE9BQU8sV0FBVztBQUMxQixRQUFNLFdBQVcsWUFBWSxTQUFTLElBQUksTUFBTSxFQUFFLE9BQU8sT0FBSyxFQUFFLFNBQVMsT0FBTztBQUNoRixRQUFNLFFBQVEsUUFBUSxZQUFZLElBQUksTUFBTSxFQUFFLE9BQU8sT0FBSyxFQUFFLFNBQVMsT0FBTztBQUU1RSxNQUFJLFNBQVMsU0FBUyxHQUFHO0FBQ3ZCLFVBQU0sV0FBVyxNQUFNLCtCQUErQixLQUFLLFlBQVksUUFBUTtBQUMvRSxRQUFJLGFBQWEsdUJBQXVCO0FBQ3RDLGFBQU8sTUFBTSxnQ0FBZ0MsS0FBSyxXQUFXO0FBQUEsSUFDL0QsV0FBVyxhQUFhLGFBQWE7QUFDbkMsYUFBTyxNQUFNLHdDQUF3QyxLQUFLLFlBQVksS0FBSztBQUFBLElBQzdFO0FBQUEsRUFDRixXQUFXLE1BQU0sU0FBUyxHQUFHO0FBQzNCLFdBQU8sTUFBTSx3Q0FBd0MsS0FBSyxZQUFZLEtBQUs7QUFBQSxFQUM3RTtBQUVBLFNBQU87QUFDVDtBQUVBLGVBQWUsd0NBQ2IsS0FDQSxvQkFDQSxPQUNpQjtBQUNqQixRQUFNLGVBQWUsSUFBSSxnQkFBZ0IsZ0JBQWdCO0FBQ3pELFFBQU0saUJBQWlCLGFBQWEsSUFBSSxnQkFBZ0I7QUFDeEQsUUFBTSw2QkFBNkIsYUFBYSxJQUFJLDRCQUE0QjtBQUloRixRQUFNLGNBQWMsb0JBQUksSUFBbUQ7QUFFM0UsUUFBTSxtQkFBbUIsSUFBSSxhQUFhO0FBQUEsSUFDeEMsUUFBUTtBQUFBLElBQ1IsTUFBTTtBQUFBLEVBQ1IsQ0FBQztBQUNELFFBQU0sUUFBUSxNQUFNLElBQUksT0FBTyxVQUFVLE1BQU0sdUNBQXVDO0FBQUEsSUFDcEYsUUFBUSxJQUFJO0FBQUEsRUFDZCxDQUFDO0FBQ0QsbUJBQWlCLFNBQVM7QUFBQSxJQUN4QixRQUFRO0FBQUEsSUFDUixNQUFNO0FBQUEsRUFDUixDQUFDO0FBQ0QsUUFBTSxTQUFTLE1BQU0sSUFBSSxPQUFPLE1BQU0sU0FBUyxvQkFBb0IsT0FBTztBQUFBLElBQ3hFLGdCQUFnQjtBQUFBO0FBQUEsSUFFaEIsT0FBTztBQUFBLElBQ1AsUUFBUSxJQUFJO0FBQUEsSUFDWixrQkFBa0IsZ0JBQWdCO0FBQ2hDLGlCQUFXLFFBQVEsZ0JBQWdCO0FBQ2pDLG9CQUFZO0FBQUEsVUFDVjtBQUFBLFVBQ0EsaUJBQWlCLGFBQWE7QUFBQSxZQUM1QixRQUFRO0FBQUEsWUFDUixNQUFNLFdBQVcsS0FBSyxJQUFJO0FBQUEsVUFDNUIsQ0FBQztBQUFBLFFBQ0g7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLElBQ0Esc0JBQXNCLE1BQU07QUFDMUIsa0JBQ0csSUFBSSxJQUFJLEVBQ1IsU0FBUyxFQUFFLFFBQVEsV0FBVyxNQUFNLGNBQWMsS0FBSyxJQUFJLGlCQUFpQixDQUFDO0FBQUEsSUFDbEY7QUFBQSxJQUNBLG9CQUFvQixNQUFNO0FBQ3hCLGtCQUNHLElBQUksSUFBSSxFQUNSLFNBQVMsRUFBRSxRQUFRLFFBQVEsTUFBTSxhQUFhLEtBQUssSUFBSSxpQkFBaUIsQ0FBQztBQUFBLElBQzlFO0FBQUEsSUFDQSw2QkFBNkIsTUFBTSxNQUFNLGdCQUFnQjtBQUN2RCxZQUFNLE9BQU8sU0FBUyxZQUFZLFlBQVksU0FBUyxhQUFhLGFBQWE7QUFDakYsa0JBQVksSUFBSSxJQUFJLEVBQUcsU0FBUztBQUFBLFFBQzlCLFFBQVE7QUFBQSxRQUNSLE1BQU0sR0FBRyxJQUFJLElBQUksS0FBSyxJQUFJLG9CQUFvQixpQkFBaUIsS0FBSyxRQUFRLENBQUMsQ0FBQztBQUFBLE1BQ2hGLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRixDQUFDO0FBRUQsU0FBTyxVQUFVLE9BQU8sUUFBUSxPQUFPLFdBQVMsTUFBTSxRQUFRLDBCQUEwQjtBQUd4RixNQUFJLG1CQUFtQjtBQUN2QixRQUFNLGdCQUFnQixPQUFPLFFBQVE7QUFDckMsTUFBSSxnQkFBZ0IsR0FBRztBQUdyQixxQkFBaUIsU0FBUztBQUFBLE1BQ3hCLFFBQVE7QUFBQSxNQUNSLE1BQU0sYUFBYSxhQUFhO0FBQUEsSUFDbEMsQ0FBQztBQUNELFFBQUksTUFBTSxxQkFBcUIsTUFBTTtBQUVyQyxVQUFNLFNBQVM7QUFDZix3QkFBb0I7QUFDcEIsUUFBSSxpQkFBaUI7QUFDckIsV0FBTyxRQUFRLFFBQVEsQ0FBQUEsWUFBVTtBQUMvQixZQUFNLGVBQWVBLFFBQU87QUFDNUIsMEJBQW9CLFlBQVksY0FBYyxNQUFNLFlBQVk7QUFBQTtBQUFBO0FBQ2hFO0FBQUEsSUFDRixDQUFDO0FBQ0QsVUFBTSxJQUFJLGFBQWEsTUFBTTtBQUM3QixVQUFNLFNBQ0o7QUFBQTtBQUFBO0FBQUE7QUFBQSxFQUVzQixrQkFBa0I7QUFDMUMsd0JBQW9CO0FBQUEsRUFDdEIsT0FBTztBQUVMLHFCQUFpQixTQUFTO0FBQUEsTUFDeEIsUUFBUTtBQUFBLE1BQ1IsTUFBTTtBQUFBLElBQ1IsQ0FBQztBQUNELFFBQUksTUFBTSw0Q0FBNEM7QUFDdEQsVUFBTSxtQ0FDSjtBQUdGLHVCQUNFLG1DQUFtQztBQUFBO0FBQUE7QUFBQTtBQUFBLEVBQXNCLGtCQUFrQjtBQUFBLEVBQy9FO0FBQ0EsTUFBSSxNQUFNLHFCQUFxQixnQkFBZ0I7QUFFL0MsU0FBTztBQUNUO0FBRUEsZUFBZSxnQ0FDYixLQUNBLE9BQ3NCO0FBQ3RCLFFBQU0sNEJBQXFELG9CQUFJLElBQUk7QUFDbkUsUUFBTSxRQUFRLE1BQU0sYUFBYSxJQUFJLFFBQVEsVUFBUSxLQUFLLFNBQVMsT0FBTztBQUMxRSxhQUFXLFFBQVEsT0FBTztBQUV4QixVQUFNLEVBQUUsUUFBUSxJQUFJLE1BQU0sSUFBSSxPQUFPLE1BQU0sY0FBYyxNQUFNO0FBQUEsTUFDN0QsUUFBUSxJQUFJO0FBQUEsSUFDZCxDQUFDO0FBRUQsUUFBSSxNQUFNO0FBQUEsdUVBQ3lELElBQUk7QUFBQSx5QkFDbEQsUUFBUSxNQUFNO0FBQUEsS0FDbEM7QUFDRCw4QkFBMEIsSUFBSSxNQUFNLE9BQU87QUFBQSxFQUM3QztBQU1BLE1BQUksMkJBQTJCO0FBRS9CLE1BQUksMEJBQTBCLE9BQU8sR0FBRztBQUN0QyxnQ0FDRTtBQUVGLGVBQVcsQ0FBQyxZQUFZLE9BQU8sS0FBSywyQkFBMkI7QUFDN0Qsa0NBQTRCO0FBQUE7QUFBQSxLQUFVLFdBQVcsSUFBSTtBQUFBO0FBQUEsRUFBdUIsT0FBTztBQUFBO0FBQUEsWUFBaUIsV0FBVyxJQUFJO0FBQUE7QUFBQTtBQUFBLElBQ3JIO0FBRUEsZ0NBQTRCO0FBQUE7QUFBQSxjQUEyRixNQUFNLFFBQVEsQ0FBQztBQUFBLEVBQ3hJO0FBRUEsUUFBTSxZQUFZLHdCQUF3QjtBQUMxQyxTQUFPO0FBQ1Q7QUFFQSxlQUFlLDZCQUNiLEtBQ0EsT0FDQSxLQUNBO0FBQ0EsTUFBSTtBQUNGLFdBQU8sTUFBTSxNQUFNLG9CQUFvQixHQUFHO0FBQUEsRUFDNUMsU0FBUyxHQUFHO0FBQ1YsVUFBTSxvQkFBb0IsSUFBSSxpQkFBaUIsRUFBRSxLQUFLLGFBQVcsUUFBUSxRQUFRLE1BQU0sTUFBTTtBQUM3RixRQUFJLENBQUMsbUJBQW1CO0FBRXRCLFlBQU0sZ0NBQWdDO0FBQ3RDLFVBQUksTUFBTTtBQUFBO0FBQUE7QUFBQSxPQUdUO0FBQ0QsWUFBTSxxQkFBcUIsSUFBSSxhQUFhLFFBQVEsNkJBQTZCO0FBQ2pGLGFBQU8sTUFBTSxNQUFNLG9CQUFvQixrQkFBa0I7QUFBQSxJQUMzRDtBQUNBLFVBQU07QUFBQSxFQUNSO0FBQ0Y7QUFFQSxlQUFlLHFCQUNiLEtBQ0EsT0FDQSxLQUNBO0FBQ0EsUUFBTSwwQkFBMEIsTUFBTSw2QkFBNkIsS0FBSyxPQUFPLEdBQUc7QUFDbEYsUUFBTSx1QkFBdUIsTUFBTSxNQUFNLFlBQVksdUJBQXVCO0FBQzVFLFFBQU0scUJBQXFCLE1BQU0sTUFBTSxpQkFBaUI7QUFDeEQsUUFBTSw4QkFBOEIscUJBQXFCO0FBQ3pELFFBQU0seUJBQTBCLHVCQUF1QixxQkFBc0I7QUFDN0UsU0FBTztBQUFBLElBQ0w7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0Y7QUFLQSxlQUFlLCtCQUNiLEtBQ0Esb0JBQ0EsT0FDMkM7QUFDM0MsUUFBTSxTQUFTLElBQUksYUFBYTtBQUFBLElBQzlCLFFBQVE7QUFBQSxJQUNSLE1BQU07QUFBQSxFQUNSLENBQUM7QUFFRCxRQUFNLGNBQWMsTUFBTSxJQUFJLFlBQVk7QUFDMUMsTUFBSSxRQUFpQztBQUNyQyxNQUFJLFlBQVksZUFBZSw0Q0FBNEM7QUFDekUsWUFBUSxNQUFNLElBQUksT0FBTyxJQUFJLE1BQU07QUFBQSxFQUNyQztBQUNBLFFBQU0sT0FBTyxNQUFNLElBQUksWUFBWTtBQUVuQyxNQUFJO0FBQ0osTUFBSTtBQUNKLE1BQUksVUFBVSxNQUFNO0FBR2xCLDJCQUF1QixLQUFLLEtBQUssS0FBSyxTQUFTLEVBQUUsU0FBUyxnQ0FBZ0M7QUFDMUYseUJBQXFCO0FBQUEsRUFDdkIsT0FBTztBQUNMLFVBQU0sZ0JBQWdCLE1BQU0scUJBQXFCLE1BQU0sT0FBTyxHQUFHO0FBQ2pFLDJCQUF1QixjQUFjO0FBQ3JDLHlCQUFxQixjQUFjO0FBQUEsRUFDckM7QUFDQSxRQUFNLDhCQUE4QixxQkFBcUI7QUFDekQsUUFBTSx5QkFBMEIsdUJBQXVCLHFCQUFzQjtBQUU3RSxNQUFJO0FBQUEsSUFDRjtBQUFBO0FBQUEsNEJBQ2dDLG9CQUFvQjtBQUFBLHlCQUN2QixrQkFBa0I7QUFBQSxtQ0FDUiwyQkFBMkI7QUFBQSw2QkFDakMsdUJBQXVCLFFBQVEsQ0FBQyxDQUFDO0FBQUE7QUFBQSxFQUNwRTtBQUdBLE1BQUksc0JBQXNCO0FBQzFCLE1BQUksZ0JBQWdCO0FBQ3BCLE1BQUksb0JBQW9CO0FBQ3hCLGFBQVcsUUFBUSxPQUFPO0FBQ3hCLFVBQU0sWUFBWSxZQUFZLElBQUk7QUFFbEMsVUFBTSxnQkFBZ0IsT0FBTyxhQUFhO0FBQUEsTUFDeEMsUUFBUTtBQUFBLE1BQ1IsTUFBTSxzQkFBc0IsS0FBSyxJQUFJO0FBQUEsSUFDdkMsQ0FBQztBQUNELFFBQUksb0JBQW9CO0FBQ3hCLFFBQUksa0JBQWtCO0FBRXRCLFVBQU0sRUFBRSxRQUFRLElBQUksTUFBTSxJQUFJLE9BQU8sTUFBTSxjQUFjLE1BQU07QUFBQSxNQUM3RCxRQUFRLElBQUk7QUFBQSxNQUNaLGdCQUFnQixZQUFVO0FBQ3hCLHNCQUFjLFNBQVM7QUFBQSxVQUNyQixRQUFRO0FBQUEsVUFDUixNQUFNLEdBQUcsT0FBTyxPQUFPLGVBQWUsS0FBSyxJQUFJO0FBQUEsUUFDakQsQ0FBQztBQUVELFlBQUksT0FBTyxZQUFZLFdBQVc7QUFDaEMsOEJBQW9CO0FBQ3BCLDRCQUFrQixTQUFTLE9BQU8sT0FBTztBQUFBLFFBQzNDO0FBQUEsTUFDRjtBQUFBLE1BQ0EsWUFBWSxjQUFZO0FBQ3RCLHNCQUFjLFNBQVM7QUFBQSxVQUNyQixRQUFRO0FBQUEsVUFDUixNQUFNLEdBQUcsaUJBQWlCLFNBQVMsS0FBSyxJQUFJLEdBQUcsZUFBZSxTQUM1RCxXQUFXLEtBQ1gsUUFBUSxDQUFDLENBQUM7QUFBQSxRQUNkLENBQUM7QUFBQSxNQUNIO0FBQUEsSUFDRixDQUFDO0FBQ0Qsa0JBQWMsT0FBTztBQUVyQixxQkFBaUIsWUFBWSxJQUFJLElBQUk7QUFHckMsVUFBTSxvQkFBb0IsWUFBWSxJQUFJO0FBQzFDLFFBQUksVUFBVSxNQUFNO0FBQ2xCLDZCQUF1QixLQUFLLEtBQUssUUFBUSxTQUFTLGdDQUFnQztBQUFBLElBQ3BGLE9BQU87QUFDTCw2QkFBdUIsTUFBTSxNQUFNLFlBQVksT0FBTztBQUFBLElBQ3hEO0FBQ0EseUJBQXFCLFlBQVksSUFBSSxJQUFJO0FBQ3pDLFFBQUksc0JBQXNCLDZCQUE2QjtBQUVyRDtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0EsTUFBSSxNQUFNLHlCQUF5QixjQUFjLFFBQVEsQ0FBQyxDQUFDLEtBQUs7QUFDaEUsTUFBSSxNQUFNLHdCQUF3QixrQkFBa0IsUUFBUSxDQUFDLENBQUMsS0FBSztBQUduRSxNQUFJLE1BQU0seUJBQXlCLGtCQUFrQixFQUFFO0FBQ3ZELE1BQUk7QUFDSixNQUFJLFVBQVUsTUFBTTtBQUNsQiwyQkFBdUIsS0FBSyxLQUFLLG1CQUFtQixTQUFTLGdDQUFnQztBQUFBLEVBQy9GLE9BQU87QUFDTCw0QkFBd0IsTUFBTSxNQUFNLFNBQVMsa0JBQWtCLEdBQUc7QUFBQSxFQUNwRTtBQUNBLFFBQU0sZ0NBQWdDLHNCQUFzQjtBQUc1RCxRQUFNLDBCQUEwQix5QkFBeUI7QUFDekQsUUFBTSwwQkFBMEI7QUFDaEMsUUFBTSxxQkFBcUIsMkJBQTJCLElBQUk7QUFDMUQsUUFBTSx5QkFBeUIsS0FBSyxNQUFNLDhCQUE4QixrQkFBa0I7QUFHMUYsTUFBSSxNQUFNLHVCQUF1QjtBQUNqQyxNQUFJLE1BQU0sK0JBQWdDLG1CQUFtQixFQUFFO0FBQy9ELE1BQUksTUFBTSxpQ0FBa0Msb0JBQW9CLEVBQUU7QUFDbEUsTUFBSSxNQUFNLDZCQUE4QiwyQkFBMkIsU0FBUztBQUM1RSxNQUFJLE1BQU0sc0JBQXVCLHVCQUF1QixRQUFRLENBQUMsQ0FBQyxHQUFHO0FBQ3JFLE1BQUksTUFBTSxzQkFBdUIsc0JBQXNCO0FBQUEsQ0FBSTtBQUUzRCxNQUFJLGdDQUFnQyx3QkFBd0I7QUFDMUQsVUFBTUMsa0JBQWlCO0FBQ3ZCLFFBQUk7QUFBQSxNQUNGLHVDQUF1Q0EsZUFBYyx1Q0FDaEQsNkJBQTZCLE1BQzlCLHFCQUFxQixHQUN2QixpQ0FBaUMsc0JBQXNCO0FBQUEsSUFDM0Q7QUFDQSxXQUFPLFNBQVM7QUFBQSxNQUNkLFFBQVE7QUFBQSxNQUNSLE1BQU0sdUNBQXVDQSxlQUFjO0FBQUEsSUFDN0QsQ0FBQztBQUNELFdBQU9BO0FBQUEsRUFDVDtBQVNBLFFBQU0saUJBQWlCO0FBQ3ZCLFNBQU8sU0FBUztBQUFBLElBQ2QsUUFBUTtBQUFBLElBQ1IsTUFBTSx1Q0FBdUMsY0FBYztBQUFBLEVBQzdELENBQUM7QUFDRCxTQUFPO0FBQ1Q7QUF4WEEsSUFBQUMsYUFXTSw0Q0FDQSxtREFDQTtBQWJOO0FBQUE7QUFBQTtBQUFBLElBQUFBLGNBUU87QUFDUDtBQUVBLElBQU0sNkNBQTZDO0FBQ25ELElBQU0sb0RBQW9EO0FBQzFELElBQU0sbUNBQW1DO0FBQUE7QUFBQTs7O0FDYnpDO0FBQUE7QUFBQTtBQUFBO0FBVUEsZUFBc0IsS0FBSyxTQUF3QjtBQUVqRCxVQUFRLHFCQUFxQixnQkFBZ0I7QUFFN0MsVUFBUSx1QkFBdUIsVUFBVTtBQUMzQztBQWZBO0FBQUE7QUFBQTtBQUNBO0FBQ0E7QUFBQTtBQUFBOzs7QUNGQSxJQUFBQyxjQUFtRDtBQUtuRCxJQUFNLG1CQUFtQixRQUFRLElBQUk7QUFDckMsSUFBTSxnQkFBZ0IsUUFBUSxJQUFJO0FBQ2xDLElBQU0sVUFBVSxRQUFRLElBQUk7QUFFNUIsSUFBTSxTQUFTLElBQUksMkJBQWU7QUFBQSxFQUNoQztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBQztBQUVBLFdBQW1CLHVCQUF1QjtBQUUzQyxJQUFJLDJCQUEyQjtBQUMvQixJQUFJLHdCQUF3QjtBQUM1QixJQUFJLHNCQUFzQjtBQUMxQixJQUFJLDRCQUE0QjtBQUNoQyxJQUFJLG1CQUFtQjtBQUN2QixJQUFJLGVBQWU7QUFFbkIsSUFBTSx1QkFBdUIsT0FBTyxRQUFRLHdCQUF3QjtBQUVwRSxJQUFNLGdCQUErQjtBQUFBLEVBQ25DLDJCQUEyQixDQUFDLGFBQWE7QUFDdkMsUUFBSSwwQkFBMEI7QUFDNUIsWUFBTSxJQUFJLE1BQU0sMENBQTBDO0FBQUEsSUFDNUQ7QUFDQSxRQUFJLGtCQUFrQjtBQUNwQixZQUFNLElBQUksTUFBTSw0REFBNEQ7QUFBQSxJQUM5RTtBQUVBLCtCQUEyQjtBQUMzQix5QkFBcUIseUJBQXlCLFFBQVE7QUFDdEQsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUNBLHdCQUF3QixDQUFDQyxnQkFBZTtBQUN0QyxRQUFJLHVCQUF1QjtBQUN6QixZQUFNLElBQUksTUFBTSx1Q0FBdUM7QUFBQSxJQUN6RDtBQUNBLDRCQUF3QjtBQUN4Qix5QkFBcUIsc0JBQXNCQSxXQUFVO0FBQ3JELFdBQU87QUFBQSxFQUNUO0FBQUEsRUFDQSxzQkFBc0IsQ0FBQ0Msc0JBQXFCO0FBQzFDLFFBQUkscUJBQXFCO0FBQ3ZCLFlBQU0sSUFBSSxNQUFNLHNDQUFzQztBQUFBLElBQ3hEO0FBQ0EsMEJBQXNCO0FBQ3RCLHlCQUFxQixvQkFBb0JBLGlCQUFnQjtBQUN6RCxXQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0EsNEJBQTRCLENBQUMsMkJBQTJCO0FBQ3RELFFBQUksMkJBQTJCO0FBQzdCLFlBQU0sSUFBSSxNQUFNLDZDQUE2QztBQUFBLElBQy9EO0FBQ0EsZ0NBQTRCO0FBQzVCLHlCQUFxQiwwQkFBMEIsc0JBQXNCO0FBQ3JFLFdBQU87QUFBQSxFQUNUO0FBQUEsRUFDQSxtQkFBbUIsQ0FBQyxrQkFBa0I7QUFDcEMsUUFBSSxrQkFBa0I7QUFDcEIsWUFBTSxJQUFJLE1BQU0sbUNBQW1DO0FBQUEsSUFDckQ7QUFDQSxRQUFJLDBCQUEwQjtBQUM1QixZQUFNLElBQUksTUFBTSw0REFBNEQ7QUFBQSxJQUM5RTtBQUVBLHVCQUFtQjtBQUNuQix5QkFBcUIsaUJBQWlCLGFBQWE7QUFDbkQsV0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUNBLGVBQWUsQ0FBQyxjQUFjO0FBQzVCLFFBQUksY0FBYztBQUNoQixZQUFNLElBQUksTUFBTSw4QkFBOEI7QUFBQSxJQUNoRDtBQUVBLG1CQUFlO0FBQ2YseUJBQXFCLGFBQWEsU0FBUztBQUMzQyxXQUFPO0FBQUEsRUFDVDtBQUNGO0FBRUEsd0RBQTRCLEtBQUssT0FBTUMsWUFBVTtBQUMvQyxTQUFPLE1BQU1BLFFBQU8sS0FBSyxhQUFhO0FBQ3hDLENBQUMsRUFBRSxLQUFLLE1BQU07QUFDWix1QkFBcUIsY0FBYztBQUNyQyxDQUFDLEVBQUUsTUFBTSxDQUFDLFVBQVU7QUFDbEIsVUFBUSxNQUFNLG9EQUFvRDtBQUNsRSxVQUFRLE1BQU0sS0FBSztBQUNyQixDQUFDOyIsCiAgIm5hbWVzIjogWyJyZXN1bHQiLCAiY2hvc2VuU3RyYXRlZ3kiLCAiaW1wb3J0X3NkayIsICJpbXBvcnRfc2RrIiwgInByZXByb2Nlc3MiLCAiY29uZmlnU2NoZW1hdGljcyIsICJtb2R1bGUiXQp9Cg==

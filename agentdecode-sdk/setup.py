from setuptools import setup, find_packages

setup(
    name="agentdecode",
    version="0.1.0",
    packages=find_packages(),
    python_requires=">=3.8",
    install_requires=[],  # zero required dependencies
    extras_require={
        "langchain": ["langchain-core>=0.1.0"]
    },
    description="Free, open-source observability for AI agents",
    long_description="Instrument your AI agents with 2 lines of code. Free forever.",
    author="AgentDecode",
    url="https://github.com/yourusername/agentdecode",
)

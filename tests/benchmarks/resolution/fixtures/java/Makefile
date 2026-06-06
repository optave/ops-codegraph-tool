SRCS = $(wildcard *.java)
JAR  = fixture.jar

.PHONY: all clean

all: $(JAR)

$(JAR): $(SRCS)
	rm -rf benchmark/
	javac -d . $(SRCS)
	jar cf $(JAR) benchmark/

clean:
	rm -f $(JAR)
	rm -rf benchmark/

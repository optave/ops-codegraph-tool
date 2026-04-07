#!/usr/bin/env clojure
;; Dynamic call tracer for Clojure fixtures.
;; Uses alter-var-root to wrap fixture functions and capture call edges.
;;
;; Usage: clojure clojure-tracer.clj <fixture-dir>
;; Outputs: { "edges": [...] } JSON to stdout

(require '[clojure.java.io :as io])
(require '[clojure.string :as str])

(def fixture-dir (first *command-line-args*))

(when-not fixture-dir
  (binding [*out* *err*]
    (println "Usage: clojure clojure-tracer.clj <fixture-dir>"))
  (System/exit 1))

(def abs-dir (.getCanonicalPath (io/file fixture-dir)))

(def edges (atom []))
(def seen (atom #{}))
(def call-stack (atom []))

(defn record-edge [caller-name caller-file callee-name callee-file]
  (let [key (str caller-name "@" caller-file "->" callee-name "@" callee-file)]
    (when-not (@seen key)
      (swap! seen conj key)
      (swap! edges conj
        {"source_name" caller-name
         "source_file" caller-file
         "target_name" callee-name
         "target_file" callee-file}))))

(defn trace-call [callee-name callee-file]
  (when (seq @call-stack)
    (let [{:keys [name file]} (peek @call-stack)]
      (record-edge name file callee-name callee-file)))
  (swap! call-stack conj {:name callee-name :file callee-file}))

(defn trace-return []
  (when (seq @call-stack)
    (swap! call-stack pop)))

;; Load fixture files
(def clj-files
  (->> (.listFiles (io/file abs-dir))
       (filter #(.endsWith (.getName %) ".clj"))
       (sort-by #(.getName %))))

;; Map namespaces to files
(def ns-file-map (atom {}))

(doseq [f clj-files]
  (let [content (slurp f)
        basename (.getName f)]
    (when-let [ns-match (re-find #"\(ns\s+([^\s\)]+)" content)]
      (swap! ns-file-map assoc (second ns-match) basename))))

;; Add fixture dir to classpath (load files directly)
(doseq [f clj-files]
  (try
    (load-file (.getCanonicalPath f))
    (catch Exception _ nil)))

;; Wrap all vars in fixture namespaces
(doseq [[ns-name basename] @ns-file-map]
  (when-let [ns-obj (find-ns (symbol ns-name))]
    (doseq [[sym var-ref] (ns-publics ns-obj)]
      (when (fn? @var-ref)
        (let [orig-fn @var-ref
              qualname (str ns-name "/" (name sym))]
          (alter-var-root var-ref
            (constantly
              (fn [& args]
                (trace-call qualname basename)
                (try
                  (apply orig-fn args)
                  (finally
                    (trace-return)))))))))))

;; Run the main function
(try
  (when-let [main-ns (find-ns 'main)]
    (when-let [run-fn (ns-resolve main-ns 'run)]
      (run-fn)))
  (catch Exception _
    nil))

;; Escape a string for safe JSON embedding
(defn json-escape [s]
  (-> (str s)
      (clojure.string/replace "\\" "\\\\")
      (clojure.string/replace "\"" "\\\"")))

;; Output JSON
(println "{")
(println "  \"edges\": [")
(doseq [[idx edge] (map-indexed vector @edges)]
  (let [comma (if (< idx (dec (count @edges))) "," "")]
    (println (str "    {"
      "\n      \"source_name\": \"" (json-escape (get edge "source_name")) "\","
      "\n      \"source_file\": \"" (json-escape (get edge "source_file")) "\","
      "\n      \"target_name\": \"" (json-escape (get edge "target_name")) "\","
      "\n      \"target_file\": \"" (json-escape (get edge "target_file")) "\""
      "\n    }" comma))))
(println "  ]")
(println "}")

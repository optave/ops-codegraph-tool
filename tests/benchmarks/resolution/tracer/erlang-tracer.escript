#!/usr/bin/env escript
%% Dynamic call tracer for Erlang fixtures.
%% Uses dbg module to capture caller->callee edges at runtime.
%%
%% Usage: escript erlang-tracer.escript <fixture-dir>
%% Outputs: { "edges": [...] } JSON to stdout

main([FixtureDir]) ->
    AbsDir = filename:absname(FixtureDir),

    %% Compile all .erl files in the fixture
    {ok, Files} = file:list_dir(AbsDir),
    ErlFiles = [F || F <- Files, filename:extension(F) =:= ".erl"],

    ModuleFileMap = lists:foldl(fun(F, Acc) ->
        FullPath = filename:join(AbsDir, F),
        ModName = list_to_atom(filename:rootname(F)),
        case compile:file(FullPath, [{outdir, AbsDir}, return_errors]) of
            {ok, _} -> maps:put(ModName, F, Acc);
            _ -> Acc
        end
    end, #{}, ErlFiles),

    %% Add fixture dir to code path
    code:add_patha(AbsDir),

    %% Set up edge collection
    put(edges, []),
    put(seen, sets:new()),
    put(call_stack, []),

    %% Set up dbg tracing
    dbg:tracer(process, {fun trace_handler/2, ModuleFileMap}),
    dbg:p(self(), [call, return_to]),

    %% Add trace patterns for all fixture modules
    maps:foreach(fun(Mod, _File) ->
        catch dbg:tp(Mod, '_', '_', [{'_', [], [{return_trace}]}])
    end, ModuleFileMap),

    %% Run the main module
    try
        main:run()
    catch
        _:_ -> ok
    end,

    %% Stop tracing
    dbg:stop(),

    %% Output edges as JSON
    Edges = lists:reverse(get(edges)),
    output_json(Edges);

main(_) ->
    io:format(standard_error, "Usage: escript erlang-tracer.escript <fixture-dir>~n", []),
    halt(1).

trace_handler({trace, _Pid, call, {Mod, Fun, _Args}}, ModFileMap) ->
    case maps:get(Mod, ModFileMap, undefined) of
        undefined -> ModFileMap;
        File ->
            FunName = atom_to_list(Fun),
            QualName = atom_to_list(Mod) ++ "." ++ FunName,
            Stack = get(call_stack),
            case Stack of
                [{CallerName, CallerFile} | _] ->
                    Key = CallerName ++ "@" ++ CallerFile ++ "->" ++ QualName ++ "@" ++ File,
                    Seen = get(seen),
                    case sets:is_element(Key, Seen) of
                        true -> ok;
                        false ->
                            put(seen, sets:add_element(Key, Seen)),
                            Edge = {CallerName, CallerFile, QualName, File},
                            put(edges, [Edge | get(edges)])
                    end;
                _ -> ok
            end,
            put(call_stack, [{QualName, File} | Stack]),
            ModFileMap
    end;

trace_handler({trace, _Pid, return_from, _MFA, _Return}, ModFileMap) ->
    case get(call_stack) of
        [_ | Rest] -> put(call_stack, Rest);
        _ -> ok
    end,
    ModFileMap;

trace_handler(_, ModFileMap) ->
    ModFileMap.

output_json(Edges) ->
    io:format("{~n  \"edges\": [~n", []),
    output_edges(Edges, length(Edges)),
    io:format("  ]~n}~n", []).

output_edges([], _) -> ok;
output_edges([{SrcName, SrcFile, TgtName, TgtFile}], _N) ->
    io:format("    {~n", []),
    io:format("      \"source_name\": \"~s\",~n", [SrcName]),
    io:format("      \"source_file\": \"~s\",~n", [SrcFile]),
    io:format("      \"target_name\": \"~s\",~n", [TgtName]),
    io:format("      \"target_file\": \"~s\"~n", [TgtFile]),
    io:format("    }~n", []);
output_edges([{SrcName, SrcFile, TgtName, TgtFile} | Rest], N) ->
    io:format("    {~n", []),
    io:format("      \"source_name\": \"~s\",~n", [SrcName]),
    io:format("      \"source_file\": \"~s\",~n", [SrcFile]),
    io:format("      \"target_name\": \"~s\",~n", [TgtName]),
    io:format("      \"target_file\": \"~s\"~n", [TgtFile]),
    io:format("    },~n", []),
    output_edges(Rest, N).

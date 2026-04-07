module main(
    input wire clk,
    input wire reset,
    output wire [7:0] result
);

    wire valid;
    wire [7:0] user_data;

    validators val_inst(
        .clk(clk),
        .data_in(user_data),
        .valid(valid)
    );

    service svc_inst(
        .clk(clk),
        .reset(reset),
        .valid(valid),
        .data_in(user_data),
        .result(result)
    );

endmodule

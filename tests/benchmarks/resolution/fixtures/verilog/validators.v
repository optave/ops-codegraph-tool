module validators(
    input wire clk,
    input wire [7:0] data_in,
    output reg valid
);

    function automatic check_range;
        input [7:0] val;
        input [7:0] min_val;
        input [7:0] max_val;
        check_range = (val >= min_val) && (val <= max_val);
    endfunction

    always @(posedge clk) begin
        valid <= check_range(data_in, 8'd1, 8'd127);
    end

endmodule

"----------------------------------------------------------------------
" Class ZCL_STRING_UTIL
"----------------------------------------------------------------------
" Simple stateless string utility class following Clean ABAP guidelines.
"----------------------------------------------------------------------
CLASS zcl_string_util DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    METHODS reverse_string
      IMPORTING
        iv_input       TYPE string
      RETURNING
        VALUE(rv_result) TYPE string.

    METHODS to_upper_case
      IMPORTING
        iv_input       TYPE string
      RETURNING
        VALUE(rv_result) TYPE string.

    METHODS to_lower_case
      IMPORTING
        iv_input       TYPE string
      RETURNING
        VALUE(rv_result) TYPE string.

ENDCLASS.


CLASS zcl_string_util IMPLEMENTATION.

  METHOD reverse_string.
    DATA(lv_length) = strlen( iv_input ).
    rv_result = ``.
    DO lv_length TIMES.
      DATA(lv_index) = lv_length - sy-index.
      rv_result = rv_result && iv_input+lv_index(1).
    ENDDO.
  ENDMETHOD.


  METHOD to_upper_case.
    rv_result = to_upper( iv_input ).
  ENDMETHOD.


  METHOD to_lower_case.
    rv_result = to_lower( iv_input ).
  ENDMETHOD.

ENDCLASS.


"----------------------------------------------------------------------
" Usage example (not part of the class):
"----------------------------------------------------------------------
" DATA(lo_util) = NEW zcl_string_util( ).
" DATA(lv_reversed) = lo_util->reverse_string( 'Hello World' ).
" " => 'dlroW olleH'
"}----------------------------------------------------------------------

"! Simple greeting class
"! Demonstrates basic Clean ABAP principles
CLASS zcl_hello_world DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    "! Build a greeting message
    "! @parameter iv_name   | Name of the person to greet
    "! @parameter rv_message | The greeting message
    METHODS greet
      IMPORTING iv_name           TYPE string DEFAULT 'World'
      RETURNING VALUE(rv_message) TYPE string.

    "! Check whether a name is provided
    "! @parameter iv_name   | Name to check
    "! @parameter rv_result | True if name is not empty
    METHODS is_name_provided
      IMPORTING iv_name          TYPE string
      RETURNING VALUE(rv_result) TYPE abap_bool.
ENDCLASS.

CLASS zcl_hello_world IMPLEMENTATION.
  METHOD greet.
    rv_message = COND #(
      WHEN is_name_provided( iv_name )
        THEN |Hello, { iv_name }!|
        ELSE |Hello, World!| ).
  ENDMETHOD.

  METHOD is_name_provided.
    rv_result = xsdbool( iv_name IS NOT INITIAL ).
  ENDMETHOD.
ENDCLASS.

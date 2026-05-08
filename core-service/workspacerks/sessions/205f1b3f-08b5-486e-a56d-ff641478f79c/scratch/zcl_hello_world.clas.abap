"! Simple greeting utility class
CLASS zcl_hello_world DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.

    "! Returns a greeting message for the given name
    "! @parameter name   | Name of the person to greet
    "! @parameter result | The greeting message
    METHODS get_greeting
      IMPORTING
        name          TYPE string
      RETURNING
        VALUE(result) TYPE string.

  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.


CLASS zcl_hello_world IMPLEMENTATION.

  METHOD get_greeting.
    result = |Hello, { name }! Welcome to SAP ABAP.|.
  ENDMETHOD.

ENDCLASS.

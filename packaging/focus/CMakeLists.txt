cmake_minimum_required(VERSION 3.18)
project(EditableFocus LANGUAGES CXX)
add_library(EditableFocus SHARED EditableFocus.cpp)
target_link_libraries(EditableFocus PRIVATE ole32 oleaut32 uiautomationcore)
